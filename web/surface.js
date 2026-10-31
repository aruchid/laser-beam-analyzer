import * as THREE from "/vendor/three.module.js";
import { OrbitControls } from "/vendor/OrbitControls.js";
export class BeamSurface {
  constructor(host, onError) {
    this.host = host;
    this.onError = onError;
    this.disposed = false;
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x101c29);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.append(this.renderer.domElement);
    this.renderer.domElement.setAttribute(
      "aria-label",
      "可旋转缩放的光束强度三维曲面",
    );
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 100);
    this.camera.position.set(1.6, 1.5, 1.8);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.15, 0);
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 8;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.enableDamping = false;
    this.controls.addEventListener("change", () => this.render());
    this.scene.add(new THREE.GridHelper(2, 10, 0x658198, 0x2b4054));
    this.scene.add(new THREE.AxesHelper(1.15));
    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      wireframe: false,
    });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.contextLost = (event) => {
      event.preventDefault();
      onError("WebGL 上下文丢失，请重新打开页面恢复三维视图。");
    };
    this.renderer.domElement.addEventListener(
      "webglcontextlost",
      this.contextLost,
    );
  }
  resize() {
    const w = this.host.clientWidth,
      h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }
  update(
    frame,
    pixels,
    { resolution = 128, gain = 1, log = false, wireframe = false } = {},
  ) {
    if (this.disposed) return;
    const nx = Math.min(resolution, frame.width),
      ny = Math.min(resolution, frame.height);
    if (!this.geometry || this.nx !== nx || this.ny !== ny) {
      if (this.mesh) this.scene.remove(this.mesh);
      this.geometry?.dispose();
      this.nx = nx;
      this.ny = ny;
      this.geometry = new THREE.BufferGeometry();
      this.geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(nx * ny * 3), 3).setUsage(
          THREE.DynamicDrawUsage,
        ),
      );
      this.geometry.setAttribute(
        "color",
        new THREE.BufferAttribute(new Float32Array(nx * ny * 3), 3).setUsage(
          THREE.DynamicDrawUsage,
        ),
      );
      const indices = [];
      for (let y = 0; y < ny - 1; y++)
        for (let x = 0; x < nx - 1; x++) {
          const a = y * nx + x,
            b = a + 1,
            c = a + nx,
            d = c + 1;
          indices.push(a, c, b, b, c, d);
        }
      this.geometry.setIndex(indices);
      this.mesh = new THREE.Mesh(this.geometry, this.material);
      this.scene.add(this.mesh);
    }
    if (this.lastPixels !== pixels) {
      this.peak = 1;
      for (const value of pixels) this.peak = Math.max(this.peak, value);
      this.lastPixels = pixels;
    }
    const peak = this.peak;
    const position = this.geometry.attributes.position,
      color = this.geometry.attributes.color,
      span = Math.max(frame.width, frame.height),
      rgb = new THREE.Color();
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const sx = Math.round((x / (nx - 1)) * (frame.width - 1)),
          sy = Math.round((y / (ny - 1)) * (frame.height - 1)),
          index = y * nx + x;
        let value = Math.max(0, pixels[sy * frame.width + sx]) / peak;
        if (log) value = Math.log1p(value * 999) / Math.log(1000);
        position.setXYZ(
          index,
          ((sx - (frame.width - 1) / 2) / span) * 2,
          value * gain,
          ((sy - (frame.height - 1) / 2) / span) * 2,
        );
        rgb.setHSL(
          (1 - Math.min(1, value)) * 0.67,
          1,
          0.48,
          THREE.SRGBColorSpace,
        );
        color.setXYZ(index, rgb.r, rgb.g, rgb.b);
      }
    position.needsUpdate = true;
    color.needsUpdate = true;
    this.geometry.computeBoundingSphere();
    this.material.wireframe = wireframe;
    this.resize();
    return {
      vertices: nx * ny,
      triangles: (nx - 1) * (ny - 1) * 2,
      width: frame.width,
      height: frame.height,
    };
  }
  reset() {
    this.camera.position.set(1.6, 1.5, 1.8);
    this.controls.target.set(0, 0.15, 0);
    this.controls.update();
    this.render();
  }
  render() {
    if (!this.disposed && this.host.clientWidth && this.host.clientHeight)
      this.renderer.render(this.scene, this.camera);
  }
  dispose() {
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.geometry?.dispose();
    this.material.dispose();
    this.renderer.domElement.removeEventListener(
      "webglcontextlost",
      this.contextLost,
    );
    this.scene.traverse((object) => {
      if (object.geometry && object.geometry !== this.geometry)
        object.geometry.dispose();
      for (const material of Array.isArray(object.material)
        ? object.material
        : [object.material])
        if (material && material !== this.material) material.dispose();
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
