#pragma once
#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <vector>
namespace beam {
struct Result {
  double cx, cy, minor, major, angle, power;
};
inline Result analyze(const std::vector<float> &image, int width, int height,
                      double background) {
  if (width < 1 || height < 1 ||
      image.size() != static_cast<size_t>(width) * height ||
      !std::isfinite(background) || background < 0)
    throw std::runtime_error("Invalid image or background");
  double power = 0, cx = 0, cy = 0;
  for (int y = 0; y < height; ++y)
    for (int x = 0; x < width; ++x) {
      double v = image[y * width + x];
      if (!std::isfinite(v) || v < 0)
        throw std::runtime_error("Invalid intensity");
      double s = std::max(v - background, 0.0);
      power += s;
      cx += s * x;
      cy += s * y;
    }
  if (power <= 0)
    throw std::runtime_error("No positive signal after background subtraction");
  cx /= power;
  cy /= power;
  double xx = 0, yy = 0, xy = 0;
  for (int y = 0; y < height; ++y)
    for (int x = 0; x < width; ++x) {
      double s = std::max(double(image[y * width + x]) - background, 0.0),
             dx = x - cx, dy = y - cy;
      xx += s * dx * dx;
      yy += s * dy * dy;
      xy += s * dx * dy;
    }
  xx /= power;
  yy /= power;
  xy /= power;
  double delta = std::hypot(xx - yy, 2 * xy);
  double minor = 4 * std::sqrt(std::max(0.0, (xx + yy - delta) / 2)),
         major = 4 * std::sqrt(std::max(0.0, (xx + yy + delta) / 2));
  double angle =
      delta < 1e-12 ? 0
                    : 0.5 * std::atan2(2 * xy, xx - yy) * 180 / std::acos(-1.0);
  return {cx, cy, minor, major, angle, power};
}
struct Fit {
  double waist, z0, theta, m2, rmse;
};
inline Fit fit(const std::vector<double> &z, const std::vector<double> &radius,
               double wavelength) {
  if (z.size() < 5 || z.size() != radius.size() || !std::isfinite(wavelength) ||
      wavelength <= 0)
    throw std::runtime_error(
        "Need at least five samples and a positive wavelength");
  auto distinct = z;
  for (size_t i = 0; i < z.size(); ++i)
    if (!std::isfinite(z[i]) || !std::isfinite(radius[i]) || radius[i] <= 0)
      throw std::runtime_error("Invalid caustic sample");
  std::sort(distinct.begin(), distinct.end());
  distinct.erase(std::unique(distinct.begin(), distinct.end()), distinct.end());
  if (distinct.size() < 5)
    throw std::runtime_error("Need five distinct axial positions");
  double origin = 0;
  for (double v : z)
    origin += v / z.size();
  double scale = distinct.back() - distinct.front();
  double a[3][4] = {};
  for (size_t k = 0; k < z.size(); ++k) {
    double u = (z[k] - origin) / scale, p[3] = {1, u, u * u};
    for (int i = 0; i < 3; ++i) {
      for (int j = 0; j < 3; ++j)
        a[i][j] += p[i] * p[j];
      a[i][3] += p[i] * radius[k] * radius[k];
    }
  }
  for (int i = 0; i < 3; ++i) {
    int pivot = i;
    for (int j = i + 1; j < 3; ++j)
      if (std::abs(a[j][i]) > std::abs(a[pivot][i]))
        pivot = j;
    if (std::abs(a[pivot][i]) < 1e-12)
      throw std::runtime_error("Ill-conditioned axial positions");
    for (int j = 0; j < 4; ++j)
      std::swap(a[i][j], a[pivot][j]);
    double d = a[i][i];
    for (int j = i; j < 4; ++j)
      a[i][j] /= d;
    for (int k = 0; k < 3; ++k)
      if (k != i) {
        double f = a[k][i];
        for (int j = i; j < 4; ++j)
          a[k][j] -= f * a[i][j];
      }
  }
  double c = a[0][3], b = a[1][3], q = a[2][3];
  if (q <= 0)
    throw std::runtime_error("Non-positive divergence");
  double w2 = c - b * b / (4 * q);
  if (w2 <= 0)
    throw std::runtime_error("Nonphysical waist");
  double waist = std::sqrt(w2), theta = std::sqrt(q) / scale,
         z0 = origin - scale * b / (2 * q), error = 0;
  for (size_t i = 0; i < z.size(); ++i) {
    double e = radius[i] - std::hypot(waist, theta * (z[i] - z0));
    error += e * e;
  }
  double m2 = std::acos(-1.0) * waist * theta / wavelength,
         rmse = std::sqrt(error / z.size());
  if (!std::isfinite(m2) || !std::isfinite(rmse) || !std::isfinite(z0))
    throw std::runtime_error("Non-finite fit result");
  return {waist, z0, theta, m2, rmse};
}
} // namespace beam
