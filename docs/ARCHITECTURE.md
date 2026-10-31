# Windows 仪器软件架构与传输协议

## 当前实现与目标设计

当前代码使用 C++ 工作进程、Node 桥接、本机 HTTP 和纯 HTML 界面。Electron 关闭 Node integration，启用 context isolation 与 renderer sandbox。图像数值和焦散计算均在 C++，Canvas 只负责显示。

| 通道          | 当前代码                                                                                    | 工控机目标                                                     |
| ------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 控制面        | stdin 命令 / stdout JSON 回执；同一时刻一个事务                                             | 版本化控制消息、request_id、取消、状态订阅；可用命名管道       |
| 数据面        | C++ 文件映射；Node 文件读取快照；HTTP 二进制传给页面                                        | Windows 共享段 + native bridge 读取；有界槽位、明确租约和回收  |
| Windows 后端  | CreateFileW / CreateFileMappingW / MapViewOfFile；发布时 FlushViewOfFile + FlushFileBuffers | 优化为不依赖磁盘刷新的页文件支持映射、事件通知和 native 消费者 |
| macOS / Linux | mmap(MAP_SHARED) 私有临时文件                                                               | 保留为开发/回归平台，不改变 Windows 主部署方向                 |

**现有路径不是端到端零拷贝。** C++ 将图像写入映射，Node 复制一次，再经 HTTP 生成 renderer 可读快照。Windows 刷新用于当前文件读取一致性，会引入代价；尚未测量实时性能。

## 进程和线程

- Renderer：界面事件、显示缓存；不可直接访问任意文件、相机或内存地址。
- Desktop/bridge：启动/关闭服务、命令队列、导入/归档、协议检查。当前所有测量写入和读取快照串行，最大排队 8 项。
- Native worker：文件输入、校正与分析、帧发布；异常转为回执错误，不输出半帧成功。
- 后续 native 线程：采集、分析、记录、控制分别有有界队列；显示可跳旧帧，测量记录不得静默丢帧。

## 帧头 v1

32 字节 little-endian uint32 头；后接连续行优先 float32。最大 2048×2048；超出需升级容量和验收，不能截断。

| 偏移  | 字段                         |
| ----- | ---------------------------- |
| 0     | magic=0x314d4142             |
| 4     | version=1                    |
| 8     | sequence                     |
| 12,16 | width,height                 |
| 20    | stride_bytes=width×4         |
| 24    | pixel_type=1                 |
| 28    | payload_bytes=width×height×4 |

单事务依次执行命令、写入、完成回执、Node 校验并复制、释放事务。读取完成前不允许下一帧写入。不是仅靠序号做无锁读取。异常或 5 秒超时终止可用状态，不把旧结果作为新结果。

## 后续共享段 v2 设计（尚未实现）

共享段头应包含 magic、协议主次版本、header_size、容量、字节序、slot_count、producer_epoch 和 heartbeat。每槽包含 state、sequence、frame_id、硬件/主机单调时钟、尺寸/步长/格式、payload_bytes、校准版本和结果偏移。

槽位生命周期：`FREE → WRITING → READY → LEASED → FREE`。发布使用跨进程 acquire/release 原子语义；Windows event 只做唤醒，不能代替状态检查。首次先采用单生产者/单 native 消费者，不假设 std::atomic 在任意布局和平台上都具备跨进程 ABI 保证。

- Producer 不覆写 LEASED 槽。显示队列可丢弃旧 READY 帧；采样记录则返回明确背压/丢帧状态。
- Native bridge 负责映射及租约；不向 HTML 暴露任意 native 指针。
- Renderer 通过受控 IPC 接收显示快照与 measurement_id。GPU 纹理、transferable buffer、SharedArrayBuffer 各需独立测量复制和生命周期成本。
- native 崩溃或重启增加 epoch，旧句柄和请求失效；先回收租约再销毁段。
- 实时采集吞吐量达到目标后再减少复制，不能为了宣称零拷贝取消所有权控制。

## 标定与帧身份

设备版每帧携带 camera_serial、pixel_format、exposure_us、gain、sensor_ROI、trigger_mode、temperature、calibration_id、dark_id。暗场与采集条件绑定。文件版 PGM 无这些信息，只能核对几何和满量程，并记录操作员标定声明。

frame_id 表示采集事件；sequence 表示计算发布，不可混用。当前离线源用 SHA-256 防止同一文件重复累计为多个采样帧。

## 输入、API 与归档

- `POST /api/image` / `/api/dark`：octet-stream P5 PGM，最大 9 MiB；8/16-bit，大端 16-bit 样本由 C++ 解码。配置通过 URL JSON 传递（ROI、背景方式、像素尺度）。
- `POST /api/measure`：当前文件的重新计算。只发布当前请求对应的参数与像素。
- `POST /api/fit`：固定轴 `[z_mm,radius_um]` 样本与波长；两轴分别调用。
- `POST /api/session`：带原图和暗场的 ZIP STORE 包，含版本化 manifest；当前会话原始文件限额 64 MiB。
- `/api/frame` 合成源仅用于开发和回归测试，产品页面不调用、不默认展示。后续发布版应置于显式开发配置下或移除。

服务只绑定 127.0.0.1，验证 Host/Origin，限定路径、内容类型、容量和尺寸。正式打包版还需加入每会话能力令牌、严格 IPC allowlist、签名与升级策略。

## 建议代码演进

`FrameSource`、`CameraAdapter`、`CalibrationStore`、`CorrectionPipeline`、`MomentAnalyzer`、`ValidityEvaluator`、`StatisticsSession`、`CausticScanController`、`StageAdapter`、`SessionArchive` 应拆为独立模块。当前 `measurement.hpp` 与 worker 命令分支是首批可验证实现，尚不是上述模块全部完成。

Windows 采集接口优先按厂商 SDK 能力适配：USB3/GigE、Mono8/Mono12/Mono16/packed、缓冲租约、触发与曝光范围查询。设备未选型时仅定义契约，不伪造枚举或驱动。
