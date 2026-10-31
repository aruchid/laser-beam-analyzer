#pragma once
#include "beam.hpp"
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>
namespace beam {
constexpr size_t MaxPixels = 2048 * 2048;
struct Image {
  int width = 0, height = 0, maxval = 0;
  std::vector<float> pixels;
};
inline std::string token(std::istream &in) {
  std::string s;
  char c;
  while (in.get(c)) {
    if (c == '#') {
      std::string comment;
      std::getline(in, comment);
      continue;
    }
    if (!std::isspace(static_cast<unsigned char>(c))) {
      s += c;
      break;
    }
  }
  while (in.get(c)) {
    if (std::isspace(static_cast<unsigned char>(c))) {
      if (c == '\r' && in.peek() == '\n')
        in.get();
      break;
    }
    if (s.size() > 16)
      throw std::runtime_error("Invalid PGM token");
    s += c;
  }
  return s;
}
inline int integer(const std::string &s) {
  if (s.empty() || s.find_first_not_of("0123456789") != std::string::npos ||
      s.size() > 8)
    throw std::runtime_error("Invalid PGM dimension");
  return std::stoi(s);
}
inline Image readPGM(const std::string &path) {
  std::ifstream in(std::filesystem::u8path(path), std::ios::binary);
  if (!in || token(in) != "P5")
    throw std::runtime_error("Expected binary P5 PGM image");
  Image image;
  image.width = integer(token(in));
  image.height = integer(token(in));
  image.maxval = integer(token(in));
  if (image.width < 8 || image.height < 8 || image.width > 2048 ||
      image.height > 2048 || image.maxval < 1 || image.maxval > 65535)
    throw std::runtime_error(
        "PGM dimensions must be 8..2048 and maxval 1..65535");
  size_t n = static_cast<size_t>(image.width) * image.height;
  image.pixels.resize(n);
  for (size_t i = 0; i < n; ++i) {
    int a = in.get(), b = image.maxval > 255 ? in.get() : 0;
    if (a < 0 || b < 0)
      throw std::runtime_error("Truncated PGM payload");
    int v = image.maxval > 255 ? (a << 8) | b : a;
    if (v > image.maxval)
      throw std::runtime_error("PGM sample exceeds maxval");
    image.pixels[i] = float(v);
  }
  if (in.peek() != std::char_traits<char>::eof())
    throw std::runtime_error("Trailing PGM data is not supported");
  return image;
}
struct ROI {
  int x = 0, y = 0, w = 0, h = 0;
};
struct Measurement {
  Result beam{};
  double dx = 0, dy = 0, peak = 0, background = 0, noise = 0, snr = 0,
         edgeFraction = 0, saturation = 0;
  bool valid = false;
  std::string error;
  ROI roi;
  std::vector<float> corrected;
};
inline Measurement measure(const Image &image, const Image *dark, ROI roi,
                           int correction) {
  if (image.pixels.size() != static_cast<size_t>(image.width) * image.height ||
      image.width < 8 || image.height < 8 || image.maxval <= 0)
    throw std::runtime_error("Invalid source image");
  if (correction < 0 || correction > 2)
    throw std::runtime_error("Invalid correction mode");
  if (correction == 2 &&
      (!dark || dark->width != image.width || dark->height != image.height ||
       dark->maxval != image.maxval))
    throw std::runtime_error(
        "Dark frame dimensions and maxval must match source");
  if (roi.w == 0 && roi.h == 0)
    roi = {0, 0, image.width, image.height};
  if (roi.x < 0 || roi.y < 0 || roi.w < 8 || roi.h < 8 ||
      roi.x > image.width - roi.w || roi.y > image.height - roi.h)
    throw std::runtime_error("ROI outside sensor or smaller than 8 pixels");
  Measurement m;
  m.roi = roi;
  m.corrected = image.pixels;
  if (correction == 2)
    for (size_t i = 0; i < m.corrected.size(); ++i)
      m.corrected[i] -= dark->pixels[i];
  int strip = std::max(1, std::min(8, std::min(roi.w, roi.h) / 10));
  double total = 0, squares = 0;
  size_t count = 0;
  for (int y = roi.y; y < roi.y + roi.h; ++y)
    for (int x = roi.x; x < roi.x + roi.w; ++x)
      if (x < roi.x + strip || y < roi.y + strip ||
          x >= roi.x + roi.w - strip || y >= roi.y + roi.h - strip) {
        double v = m.corrected[y * image.width + x];
        total += v;
        squares += v * v;
        ++count;
      }
  m.background = total / count;
  m.noise =
      std::sqrt(std::max(0.0, squares / count - m.background * m.background));
  // Signed baseline subtraction preserves negative noise; no max(signal,0) in
  // the measurement path.
  if (correction == 1)
    for (auto &v : m.corrected)
      v -= float(m.background);
  double power = 0, cx = 0, cy = 0, edge = 0, positive = 0;
  size_t saturated = 0;
  for (int y = roi.y; y < roi.y + roi.h; ++y)
    for (int x = roi.x; x < roi.x + roi.w; ++x) {
      auto i = y * image.width + x;
      double s = m.corrected[i];
      if (!std::isfinite(s))
        throw std::runtime_error("Non-finite signal");
      power += s;
      cx += x * s;
      cy += y * s;
      m.peak = std::max(m.peak, s);
      positive += std::max(0.0, s);
      if (image.pixels[i] >= image.maxval)
        ++saturated;
      if (x < roi.x + strip || y < roi.y + strip ||
          x >= roi.x + roi.w - strip || y >= roi.y + roi.h - strip)
        edge += std::max(0.0, s);
    }
  m.saturation = double(saturated) / (roi.w * roi.h);
  m.edgeFraction = positive > 0 ? edge / positive : 0;
  m.snr = m.noise > 1e-12 ? m.peak / m.noise : 0;
  if (power <= 0) {
    m.error = "Non-positive integrated signal";
    return m;
  }
  cx /= power;
  cy /= power;
  double xx = 0, yy = 0, xy = 0;
  for (int y = roi.y; y < roi.y + roi.h; ++y)
    for (int x = roi.x; x < roi.x + roi.w; ++x) {
      double s = m.corrected[y * image.width + x], a = x - cx, b = y - cy;
      xx += s * a * a;
      yy += s * b * b;
      xy += s * a * b;
    }
  xx /= power;
  yy /= power;
  xy /= power;
  double delta = std::hypot(xx - yy, 2 * xy), minor = (xx + yy - delta) / 2,
         major = (xx + yy + delta) / 2;
  if (!std::isfinite(major) || minor <= 0 || major <= 0 || cx < roi.x ||
      cx >= roi.x + roi.w || cy < roi.y || cy >= roi.y + roi.h) {
    m.error = "Nonphysical moments; check background and ROI";
    return m;
  }
  m.beam = {cx,
            cy,
            4 * std::sqrt(minor),
            4 * std::sqrt(major),
            delta < 1e-12 ? 0
                          : std::atan2(2 * xy, xx - yy) * 90 / std::acos(-1.0),
            power};
  m.dx = 4 * std::sqrt(xx);
  m.dy = 4 * std::sqrt(yy);
  m.valid = true;
  return m;
}
} // namespace beam
