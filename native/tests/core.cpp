#include "beam.hpp"
#include "measurement.hpp"
#include <iostream>
void check(bool condition) {
  if (!condition)
    throw std::runtime_error("Test failed");
}
template <class F> void rejects(F f) {
  bool failed = false;
  try {
    f();
  } catch (const std::exception &) {
    failed = true;
  }
  check(failed);
}
int main() {
  try {
    std::vector<float> img(300 * 220);
    double angle = .4, c = std::cos(angle), s = std::sin(angle);
    for (int y = 0; y < 220; ++y)
      for (int x = 0; x < 300; ++x) {
        double dx = x - 146, dy = y - 104, u = c * dx + s * dy,
               v = -s * dx + c * dy;
        img[y * 300 + x] =
            3 + 100 * std::exp(-.5 * (u * u / 625 + v * v / 196));
      }
    auto r = beam::analyze(img, 300, 220, 3);
    check(std::abs(r.cx - 146) < 1e-5 && std::abs(r.cy - 104) < 1e-5);
    check(std::abs(r.minor - 56) < 1e-4 && std::abs(r.major - 100) < 1e-4);
    check(std::abs(r.angle - angle * 180 / std::acos(-1.0)) < 1e-5);
    rejects([&] { beam::analyze({}, 1, 1, 0); });
    rejects([&] { beam::analyze({0}, 1, 1, 0); });
    rejects([&] { beam::analyze({NAN}, 1, 1, 0); });
    rejects([&] { beam::analyze({-1}, 1, 1, 0); });
    std::vector<double> z, w;
    double lambda = 1064e-9, waist = .00025,
           theta = 1.4 * lambda / (std::acos(-1.0) * waist);
    for (int i = 0; i < 25; ++i) {
      double v = -.5 + i / 24.0;
      z.push_back(v);
      w.push_back(std::hypot(waist, theta * (v - .03)));
    }
    auto fit = beam::fit(z, w, lambda);
    check(std::abs(fit.m2 - 1.4) < 1e-9);
    check(std::abs(fit.z0 - .03) < 1e-10);
    check(std::abs(fit.waist - waist) < 1e-12);
    check(fit.rmse < 1e-12);
    rejects([&] { beam::fit({1, 1, 1, 1, 1}, {1, 1, 1, 1, 1}, lambda); });
    rejects([&] { beam::fit(z, w, 0); });
    w[0] = NAN;
    rejects([&] { beam::fit(z, w, lambda); });
    beam::Image raw{300, 220, 65535, {}}, dark{300, 220, 65535, {}};
    raw.pixels.resize(300 * 220);
    dark.pixels.assign(300 * 220, 1000);
    for (int y = 0; y < 220; ++y)
      for (int x = 0; x < 300; ++x) {
        double dx = x - 146, dy = y - 104;
        raw.pixels[y * 300 + x] =
            float(1000 + 100 * std::exp(-.5 * (dx * dx / 625 + dy * dy / 196)) +
                  ((x + y) % 2 ? 1 : -1));
      }
    auto measurement = beam::measure(raw, &dark, {}, 2);
    check(measurement.valid);
    check(*std::min_element(measurement.corrected.begin(),
                            measurement.corrected.end()) < 0);
    check(std::abs(measurement.beam.cx - 146) < .001);
    check(measurement.saturation == 0);
    rejects([&] { beam::measure(raw, nullptr, {}, 2); });
    rejects([&] { beam::measure(raw, nullptr, {299, 0, 8, 8}, 1); });
    raw.pixels[0] = 65535;
    check(beam::measure(raw, &dark, {}, 2).saturation > 0);
    std::cout << "PASS: rotated Gaussian recovery, input rejection, analytic "
                 "M2 recovery, fit rejection\n";
  } catch (const std::exception &e) {
    std::cerr << e.what() << '\n';
    return 1;
  }
}
