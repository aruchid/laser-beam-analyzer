# M² 光束焦散拟合原型

这是从零实现的最小数值原型，默认运行确定性合成样例。

## 安装与运行

需要 Python 3.11+。

```sh
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python src/m2.py --wavelength 0.000001064 --output artifacts
```

## 自有数据

带 z_m,w_m 表头的两列 CSV，轴向位置和光束半径单位均为米；波长单位为米。二次拟合恢复束腰、发散角及 M²；不是完整的标准符合性测量系统。

```sh
python src/m2.py --input your-data.csv --wavelength 0.000001064 --output artifacts
```

## 实际运行结果

下面是当前代码生成的合成样例结果图，不是设备实测或 UI 截图。

![运行结果](artifacts/result.png)

## 文档

- [PRD](docs/PRD.md)
- [验证记录](docs/VALIDATION.md)

## 限制

尚未接入真实硬件或现场数据，未提供实时界面；生产性能和测量不确定度待验证。原有文档中的概念架构图与本原型运行结果分开保存。
