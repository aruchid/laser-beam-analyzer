#include "beam.hpp"
#include "measurement.hpp"
#include <chrono>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#endif
struct Mapping {
  void *data = nullptr;
  size_t size;
#ifdef _WIN32
  HANDLE file = INVALID_HANDLE_VALUE, mapping = nullptr;
  Mapping(const char *path, size_t n) : size(n) {
    auto name = std::filesystem::u8path(path);
    file =
        CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_TEMPORARY, nullptr);
    if (file == INVALID_HANDLE_VALUE)
      throw std::runtime_error("Cannot open Windows frame file");
    LARGE_INTEGER bytes;
    bytes.QuadPart = static_cast<LONGLONG>(n);
    if (!SetFilePointerEx(file, bytes, nullptr, FILE_BEGIN) ||
        !SetEndOfFile(file)) {
      CloseHandle(file);
      throw std::runtime_error("Cannot resize Windows mapping");
    }
    mapping = CreateFileMappingW(file, nullptr, PAGE_READWRITE, 0, 0, nullptr);
    if (mapping)
      data = MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, n);
    if (!data) {
      if (mapping)
        CloseHandle(mapping);
      CloseHandle(file);
      throw std::runtime_error("Cannot map Windows frame file");
    }
  }
  ~Mapping() {
    if (data)
      UnmapViewOfFile(data);
    if (mapping)
      CloseHandle(mapping);
    if (file != INVALID_HANDLE_VALUE)
      CloseHandle(file);
  }
#else
  int fd = -1;
  Mapping(const char *path, size_t n) : size(n) {
    fd = open(path, O_RDWR);
    if (fd < 0)
      throw std::runtime_error("Cannot open transport");
    if (ftruncate(fd, n) != 0) {
      close(fd);
      throw std::runtime_error("Cannot resize mapping");
    }
    data = mmap(nullptr, n, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (data == MAP_FAILED) {
      close(fd);
      throw std::runtime_error("Cannot map frame");
    }
  }
  ~Mapping() {
    if (data && data != MAP_FAILED)
      munmap(data, size);
    if (fd >= 0)
      close(fd);
  }
#endif
  void publish(const uint32_t *header, const std::vector<float> &pixels) {
    if (32 + pixels.size() * 4 > size)
      throw std::runtime_error("Frame exceeds capacity");
    std::memcpy(data, header, 32);
    std::memcpy(static_cast<char *>(data) + 32, pixels.data(),
                pixels.size() * 4);
#ifdef _WIN32
    if (!FlushViewOfFile(data, 32 + pixels.size() * 4) ||
        !FlushFileBuffers(file))
      throw std::runtime_error("Cannot publish Windows frame");
#endif
  }
};
bool clean(std::istringstream &s) {
  s >> std::ws;
  return s.eof();
}
int runWorker(int argc, char **argv) {
  if (argc != 3)
    return 2;
  try {
    constexpr int width = 384, height = 288;
    Mapping mapping(argv[1], 32 + beam::MaxPixels * sizeof(float));
    const std::string staging = argv[2];
    beam::Image imported, dark;
    bool hasImage = false, hasDark = false;
    std::vector<float> image(width * height);
    uint32_t sequence = 0;
    std::cout << std::setprecision(14);
    for (std::string line; std::getline(std::cin, line);) {
      try {
        auto begin = std::chrono::steady_clock::now();
        std::istringstream in(line);
        std::string command;
        in >> command;
        if (command == "QUIT")
          break;
        if (command == "FRAME") {
          double sx, sy, angle, bg, sub, cx, cy, pitch;
          if (!(in >> sx >> sy >> angle >> bg >> sub >> cx >> cy >> pitch) ||
              !clean(in))
            throw std::runtime_error("Invalid frame request");
          for (double v : {sx, sy, angle, bg, sub, cx, cy, pitch})
            if (!std::isfinite(v))
              throw std::runtime_error("Non-finite setting");
          if (sx < 2 || sx > 65 || sy < 2 || sy > 65 || std::abs(angle) > 180 ||
              bg < 0 || bg > 200 || sub < 0 || sub > 1200 || cx < 0 ||
              cx >= width || cy < 0 || cy >= height || pitch <= 0 ||
              pitch > 100)
            throw std::runtime_error("Settings out of range");
          double t = angle * std::acos(-1.0) / 180, c = std::cos(t),
                 s = std::sin(t);
          for (int y = 0; y < height; ++y)
            for (int x = 0; x < width; ++x) {
              double dx = x - cx, dy = y - cy, u = c * dx + s * dy,
                     v = -s * dx + c * dy;
              image[y * width + x] =
                  float(bg + 1000 * std::exp(-.5 * (u * u / (sx * sx) +
                                                    v * v / (sy * sy))));
            }
          auto r = beam::analyze(image, width, height, sub);
          ++sequence;
          uint32_t header[8] = {0x314d4142, 1, sequence,          width, height,
                                width * 4,  1, width * height * 4};
          mapping.publish(header, image);
          // Publication is the flushed stdout notification, not an
          // unsynchronized browser read.
          double ms = std::chrono::duration<double, std::milli>(
                          std::chrono::steady_clock::now() - begin)
                          .count();
          bool clipped = cx < 4 * std::max(sx, sy) ||
                         width - 1 - cx < 4 * std::max(sx, sy) ||
                         cy < 4 * std::max(sx, sy) ||
                         height - 1 - cy < 4 * std::max(sx, sy);
          std::cout << "{\"ok\":true,\"kind\":\"frame\",\"sequence\":"
                    << sequence << ",\"width\":" << width
                    << ",\"height\":" << height << ",\"centroid_px\":[" << r.cx
                    << "," << r.cy << "],\"minor_px\":" << r.minor
                    << ",\"major_px\":" << r.major
                    << ",\"angle_deg\":" << r.angle
                    << ",\"ellipticity\":" << r.minor / r.major
                    << ",\"signal\":" << r.power << ",\"pitch_um\":" << pitch
                    << ",\"compute_ms\":" << ms
                    << ",\"clipped\":" << (clipped ? "true" : "false")
                    << ",\"source\":\"synthetic\"}" << std::endl;
        } else if (command == "IMPORT" || command == "DARK" ||
                   command == "MEASURE") {
          beam::ROI roi;
          int correction;
          double pitch;
          if (!(in >> roi.x >> roi.y >> roi.w >> roi.h >> correction >>
                pitch) ||
              !clean(in) || !std::isfinite(pitch) || pitch <= 0 || pitch > 100)
            throw std::runtime_error("Invalid measurement configuration");
          if (command == "IMPORT") {
            auto candidate = beam::readPGM(staging);
            beam::measure(candidate, nullptr, roi, correction);
            imported = std::move(candidate);
            hasImage = true;
            hasDark = false;
          }
          if (command == "DARK") {
            auto candidate = beam::readPGM(staging);
            if (!hasImage || candidate.width != imported.width ||
                candidate.height != imported.height ||
                candidate.maxval != imported.maxval)
              throw std::runtime_error("Dark frame does not match source");
            dark = std::move(candidate);
            hasDark = true;
          }
          if (!hasImage)
            throw std::runtime_error("No source image loaded");
          auto m = beam::measure(imported, hasDark ? &dark : nullptr, roi,
                                 correction);
          ++sequence;
          uint32_t header[8] = {0x314d4142,
                                1,
                                sequence,
                                static_cast<uint32_t>(imported.width),
                                static_cast<uint32_t>(imported.height),
                                static_cast<uint32_t>(imported.width * 4),
                                1,
                                static_cast<uint32_t>(m.corrected.size() * 4)};
          mapping.publish(header, m.corrected);
          double ms = std::chrono::duration<double, std::milli>(
                          std::chrono::steady_clock::now() - begin)
                          .count();
          bool accepted = m.valid && correction != 0 && m.saturation == 0 &&
                          m.edgeFraction < .02 &&
                          (m.noise < 1e-12 || m.snr >= 10);
          std::cout << "{\"ok\":true,\"source\":\"file\",\"sequence\":"
                    << sequence << ",\"width\":" << imported.width
                    << ",\"height\":" << imported.height
                    << ",\"maxval\":" << imported.maxval
                    << ",\"pitch_um\":" << pitch
                    << ",\"valid\":" << (m.valid ? "true" : "false")
                    << ",\"accepted\":" << (accepted ? "true" : "false")
                    << ",\"correction\":" << correction
                    << ",\"has_dark\":" << (hasDark ? "true" : "false")
                    << ",\"roi\":[" << m.roi.x << "," << m.roi.y << ","
                    << m.roi.w << "," << m.roi.h << "],\"centroid_px\":["
                    << m.beam.cx << "," << m.beam.cy
                    << "],\"major_px\":" << m.beam.major
                    << ",\"minor_px\":" << m.beam.minor << ",\"dx_px\":" << m.dx
                    << ",\"dy_px\":" << m.dy
                    << ",\"angle_deg\":" << m.beam.angle
                    << ",\"signal\":" << m.beam.power << ",\"peak\":" << m.peak
                    << ",\"background\":" << m.background
                    << ",\"noise\":" << m.noise << ",\"snr\":" << m.snr
                    << ",\"edge_fraction\":" << m.edgeFraction
                    << ",\"saturation_fraction\":" << m.saturation
                    << ",\"compute_ms\":" << ms << ",\"error\":\"" << m.error
                    << "\"}" << std::endl;
        } else if (command == "FIT") {
          double wavelength;
          int n;
          if (!(in >> wavelength >> n) || n < 5 || n > 512)
            throw std::runtime_error("Invalid fit request");
          std::vector<double> z(n), w(n);
          for (int i = 0; i < n; ++i)
            if (!(in >> z[i] >> w[i]))
              throw std::runtime_error("Missing caustic sample");
          if (!clean(in))
            throw std::runtime_error("Unexpected fit input");
          auto r = beam::fit(z, w, wavelength);
          std::cout << "{\"ok\":true,\"kind\":\"fit\",\"waist_radius_m\":"
                    << r.waist << ",\"waist_position_m\":" << r.z0
                    << ",\"divergence_rad\":" << r.theta << ",\"M2\":" << r.m2
                    << ",\"radius_rmse_m\":" << r.rmse << "}" << std::endl;
        } else
          throw std::runtime_error("Unknown command");
      } catch (const std::exception &e) {
        std::cout << "{\"ok\":false,\"error\":\"" << e.what() << "\"}"
                  << std::endl;
      }
    }
  } catch (const std::exception &e) {
    std::cerr << e.what() << std::endl;
    return 1;
  }
  return 0;
}

#ifdef _WIN32
int wmain(int argc, wchar_t **wide) {
  std::vector<std::string> utf8;
  std::vector<char *> args;
  for (int i = 0; i < argc; ++i) {
    int n = WideCharToMultiByte(CP_UTF8, 0, wide[i], -1, nullptr, 0, nullptr,
                                nullptr);
    std::string value(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, wide[i], -1, value.data(), n, nullptr,
                        nullptr);
    value.pop_back();
    utf8.push_back(std::move(value));
  }
  for (auto &arg : utf8)
    args.push_back(arg.data());
  return runWorker(argc, args.data());
}
#else
int main(int argc, char **argv) { return runWorker(argc, argv); }
#endif
