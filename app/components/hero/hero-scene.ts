import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { feeJourney, clamp, ramp } from "./journey";

type Options = {
  container: HTMLDivElement; section: HTMLElement; viewport: HTMLDivElement;
  labels: (HTMLButtonElement | null)[]; coreLabel: HTMLElement; incomingLabel: HTMLElement;
  progressBar: HTMLElement; phaseLabel: HTMLElement; selected: { current: number };
  onReady: () => void; onFailure: () => void;
};
const V = (x: number, y: number, z = 0) => new THREE.Vector3(x, y, z);
const purple = 0xa258ff;
const shares = [40, 30, 20, 10];

function frame(width: number, height: number, depth: number, material: THREE.Material) {
  const group = new THREE.Group();
  // Separate rails leave an actual window into the processor instead of an opaque cube.
  for (const x of [-width / 2, width / 2]) {
    const rail = new THREE.Mesh(new RoundedBoxGeometry(.09, height, depth, 2, .04), material);
    rail.position.x = x; group.add(rail);
  }
  for (const y of [-height / 2, height / 2]) {
    const rail = new THREE.Mesh(new RoundedBoxGeometry(width, .09, depth, 2, .04), material);
    rail.position.y = y; group.add(rail);
  }
  return group;
}

function makeGlowTexture() {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,245,255,1)");
  gradient.addColorStop(.14, "rgba(215,165,255,.95)");
  gradient.addColorStop(.35, "rgba(157,62,255,.45)");
  gradient.addColorStop(1, "rgba(115,35,255,0)");
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

export function SplitCore(chrome: THREE.Material, glass: THREE.Material) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new RoundedBoxGeometry(2.05, 2.75, .65, 4, .22), glass);
  group.add(body);
  for (const z of [-.42, -.12, .35, .48]) {
    const outline = frame(1.95, 2.6, .07, chrome); outline.position.z = z; group.add(outline);
  }
  const inner = new THREE.Mesh(new RoundedBoxGeometry(1.65, 2.25, .14, 3, .15), new THREE.MeshPhysicalMaterial({ color: 0x10071e, roughness: .22, metalness: .65, clearcoat: 1, transparent: true, opacity: .8 }));
  inner.position.z = .3; group.add(inner);
  const lightMaterial = new THREE.MeshBasicMaterial({ color: purple, transparent: true, opacity: .5 });
  const glowFrame = frame(1.7, 2.35, .02, lightMaterial); glowFrame.position.z = .41; group.add(glowFrame);
  const channels = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const curve = new THREE.CubicBezierCurve3(V(-.7, 0), V(0, 0), V(.2, (1.5 - i) * .45), V(.95, (1.5 - i) * .45));
    channels.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 24, .028, 6, false), lightMaterial));
  }
  channels.position.z = .42; group.add(channels);
  for (const x of [-.83, .83]) for (const y of [-1.1, 1.1]) {
    const bolt = new THREE.Mesh(new THREE.CylinderGeometry(.05, .05, .04, 8), chrome);
    bolt.rotation.x = Math.PI / 2; bolt.position.set(x, y, .52); group.add(bolt);
  }
  return { group, inner, lightMaterial, channels };
}

export function FeeOrb(texture: THREE.Texture) {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.SphereGeometry(.16, 24, 16), new THREE.MeshBasicMaterial({ color: 0xf8dcff })));
  group.add(new THREE.Mesh(new THREE.SphereGeometry(.26, 24, 16), new THREE.MeshPhysicalMaterial({ color: 0xbf79ff, roughness: .08, metalness: .12, transparent: true, opacity: .38, side: THREE.DoubleSide })));
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, color: 0xd7a5ff, blending: THREE.AdditiveBlending, depthWrite: false, opacity: .85 }));
  halo.scale.setScalar(1.45); group.add(halo);
  const light = new THREE.PointLight(0xaa4aff, 5, 4, 2); group.add(light);
  return { group, halo, light };
}

export function RoutingTube(curve: THREE.Curve<THREE.Vector3>, radius: number, glass: THREE.Material, chrome: THREE.Material, segments: number) {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, segments, radius, 10, false), glass));
  const energyMaterial = new THREE.MeshBasicMaterial({ color: purple, transparent: true, opacity: .08, blending: THREE.AdditiveBlending, depthWrite: false });
  const energy = new THREE.Mesh(new THREE.TubeGeometry(curve, segments, radius * .45, 8, false), energyMaterial);
  group.add(energy);
  // Longitudinal glass highlights give the transparent conduit a readable edge.
  for (const z of [-radius * .8, radius * .8]) {
    const points = curve.getPoints(segments).map((p) => p.add(V(0, 0, z)));
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0xb78cff, transparent: true, opacity: .55 })); group.add(line);
  }
  for (const t of [0, .035, .965, 1]) {
    const collar = new THREE.Mesh(new THREE.TorusGeometry(radius * 1.08, .035, 6, 20), chrome);
    collar.position.copy(curve.getPoint(t)); collar.quaternion.setFromUnitVectors(V(0, 0, 1), curve.getTangent(t)); group.add(collar);
  }
  return { group, energy, energyMaterial };
}

export const IncomingConduit = RoutingTube;

export function DestinationNode(chrome: THREE.Material, glass: THREE.Material, mobile: boolean) {
  const group = new THREE.Group();
  const width = mobile ? 1.55 : 2.35;
  const body = new THREE.Mesh(new RoundedBoxGeometry(width, .94, .28, 3, .13), glass); group.add(body);
  const front = new THREE.Mesh(new RoundedBoxGeometry(width - .13, .8, .04, 2, .09), new THREE.MeshPhysicalMaterial({ color: 0x090411, metalness: .5, roughness: .24, clearcoat: 1 }));
  front.position.z = .16; group.add(front);
  const edge = frame(width - .05, .87, .06, chrome); edge.position.z = .12; group.add(edge);
  const lightMaterial = new THREE.MeshBasicMaterial({ color: purple, transparent: true, opacity: .3 });
  const rim = frame(width - .14, .77, .018, lightMaterial); rim.position.z = .19; group.add(rim);
  return { group, lightMaterial };
}

export function EnergyParticles(curve: THREE.Curve<THREE.Vector3>, count: number, radius: number, texture: THREE.Texture) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const initialPoint = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    curve.getPoint(0, initialPoint);
    positions[i * 3] = initialPoint.x;
    positions[i * 3 + 1] = initialPoint.y;
    positions[i * 3 + 2] = initialPoint.z;
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 30);
  const material = new THREE.PointsMaterial({ color: 0xdec3ff, size: .065, map: texture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  const point = new THREE.Vector3();
  return { points, update(head: number, spread: number, activity: number) {
    const safeHead = Number.isFinite(head) ? head : 0;
    const safeSpread = Number.isFinite(spread) ? Math.max(0, spread) : 0;
    const safeActivity = Number.isFinite(activity) ? activity : 0;
    for (let i = 0; i < count; i++) {
      const t = clamp(safeHead - (i / count) * safeSpread);
      curve.getPoint(t, point);
      const angle = i * 2.399 + safeActivity;
      const x = point.x;
      const y = point.y + Math.sin(angle) * radius * .62;
      const z = point.z + Math.cos(angle) * radius * .62;
      positions[i * 3] = Number.isFinite(x) ? x : 0;
      positions[i * 3 + 1] = Number.isFinite(y) ? y : 0;
      positions[i * 3 + 2] = Number.isFinite(z) ? z : 0;
    }
    geometry.attributes.position.needsUpdate = true;
  } };
}

export function createHeroScene(options: Options) {
  const { container, section, viewport, labels, coreLabel, incomingLabel, progressBar, phaseLabel, selected } = options;
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
  renderer.setClearColor(0x000000, 0); renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.35;
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, .1, 100);
  scene.add(new THREE.HemisphereLight(0xe4d4ff, 0x160624, 2.3));
  scene.add(new THREE.AmbientLight(0xbca2e6, 1.7));
  const key = new THREE.DirectionalLight(0xe1cfff, 5); key.position.set(-3, 5, 5); scene.add(key);
  const edgeLight = new THREE.DirectionalLight(0x873cff, 4); edgeLight.position.set(5, -2, 3); scene.add(edgeLight);
  const frontLight = new THREE.PointLight(0xe7ceff, 9, 24, 1.5); frontLight.position.set(0, 0, 7); scene.add(frontLight);
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc8b4e4, metalness: .92, roughness: .16 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x633294, metalness: .16, roughness: .1, transmission: .55, thickness: .4, ior: 1.45, transparent: true, opacity: .54, clearcoat: 1, side: THREE.DoubleSide });
  const glowTexture = makeGlowTexture();
  const assembly = new THREE.Group(); scene.add(assembly);
  let mobile = false, width = 1, height = 1;
  let core: ReturnType<typeof SplitCore>;
  let orb: ReturnType<typeof FeeOrb>;
  let incoming: THREE.CubicBezierCurve3;
  let inlet: ReturnType<typeof IncomingConduit>;
  let trail: ReturnType<typeof EnergyParticles>;
  let nodes: ReturnType<typeof DestinationNode>[] = [];
  let routes: { tube: ReturnType<typeof RoutingTube>; particles: ReturnType<typeof EnergyParticles> }[] = [];
  const resources = new Set<THREE.BufferGeometry | THREE.Material>();
  function clearAssembly() {
    assembly.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points || object instanceof THREE.Sprite) {
        if ("geometry" in object) resources.add(object.geometry);
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((m) => { if (m !== chrome && m !== glass) resources.add(m); });
      }
    });
    resources.forEach((r) => r.dispose()); resources.clear(); assembly.clear();
  }
  function build() {
    clearAssembly(); nodes = []; routes = [];
    const center = mobile ? V(-.95, .6) : V(1.65, .35);
    core = SplitCore(chrome, glass); core.group.position.copy(center); core.group.scale.setScalar(mobile ? .68 : 1.08); assembly.add(core.group);
    incoming = new THREE.CubicBezierCurve3(mobile ? V(-2.5, 3.35, -.1) : V(-8, .3, -.3), mobile ? V(-3.4, 1.4, .5) : V(-5, -.9, .4), mobile ? V(-3, .6, .3) : V(-1.7, -.2, .3), center.clone().add(V(mobile ? -.68 : -1.08, 0)));
    inlet = IncomingConduit(incoming, mobile ? .16 : .26, glass, chrome, mobile ? 36 : 64); assembly.add(inlet.group);
    orb = FeeOrb(glowTexture); if (mobile) orb.group.scale.setScalar(.7); assembly.add(orb.group);
    trail = EnergyParticles(incoming, mobile ? 24 : 64, mobile ? .1 : .22, glowTexture); assembly.add(trail.points);
    for (let i = 0; i < 4; i++) {
      const destination = mobile ? V(1.4, 2.35 - i * 1.4, .05) : V(6.55, 2.85 - i * 1.6, .1);
      const start = center.clone().add(V(mobile ? .69 : 1.08, (1.5 - i) * (mobile ? .32 : .54), 0));
      const end = destination.clone().add(V(mobile ? -.79 : -1.2, 0));
      const curve = new THREE.CubicBezierCurve3(start, start.clone().add(V(mobile ? .75 : 1.35, 0, .15)), end.clone().add(V(mobile ? -.7 : -1.2, 0, .15)), end);
      const radius = (mobile ? .08 : .13) * Math.sqrt(shares[i] / 10);
      const tube = RoutingTube(curve, radius, glass, chrome, mobile ? 32 : 56); assembly.add(tube.group);
      const particles = EnergyParticles(curve, (mobile ? 6 : 12) * (4 - i), radius, glowTexture); assembly.add(particles.points);
      routes.push({ tube, particles });
      const node = DestinationNode(chrome, glass, mobile); node.group.position.copy(destination); nodes.push(node); assembly.add(node.group);
    }
  }
  let disposed = false, frameId = 0, visible = true, lastTime = 0, elapsed = 0;
  let targetProgress = 0, progress = 0, hover = 0;
  const pointer = new THREE.Vector2(), dampedPointer = new THREE.Vector2();
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reduced = media.matches || document.documentElement.dataset.motion === "reduced";
  const projection = new THREE.Vector3();
  function project(element: HTMLElement | null, position: THREE.Vector3) {
    if (!element) return;
    projection.copy(position).applyMatrix4(assembly.matrixWorld).project(camera);
    element.style.left = `${(projection.x * .5 + .5) * width}px`;
    element.style.top = `${(-projection.y * .5 + .5) * height}px`;
  }
  function updateScroll() {
    const rect = section.getBoundingClientRect();
    targetProgress = clamp(-rect.top / Math.max(1, rect.height - viewport.clientHeight));
    wake();
  }
  function resize() {
    width = container.clientWidth; height = container.clientHeight;
    if (!width || !height) return;
    const nextMobile = window.innerWidth <= 700;
    if (!core || nextMobile !== mobile) { mobile = nextMobile; build(); }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1.15 : 1.6)); renderer.setSize(width, height);
    camera.aspect = width / height; camera.updateProjectionMatrix(); updateScroll();
  }
  const onPointer = (event: PointerEvent) => {
    const rect = viewport.getBoundingClientRect();
    const strength = event.pointerType === "touch" ? .3 : 1;
    pointer.set(((event.clientX - rect.left) / rect.width - .5) * 2 * strength, ((event.clientY - rect.top) / rect.height - .5) * 2 * strength);
    const orbPosition = orb.group.position.clone().applyMatrix4(assembly.matrixWorld).project(camera);
    const stageRect = container.getBoundingClientRect();
    const distance = Math.hypot(event.clientX - stageRect.left - (orbPosition.x * .5 + .5) * width, event.clientY - stageRect.top - (-orbPosition.y * .5 + .5) * height);
    hover = clamp(1 - distance / 120); renderer.domElement.style.cursor = hover > .3 ? "help" : "auto";
    wake();
  };
  const onLeave = () => { pointer.set(0, 0); hover = 0; wake(); };
  function tick(now: number) {
    frameId = 0;
    if (disposed || !visible || document.hidden || !core) return;
    const dt = Math.min((now - lastTime) / 1000 || .016, .05); lastTime = now;
    elapsed += reduced ? 0 : dt;
    const damping = 1 - Math.exp(-dt * 7);
    progress = reduced ? targetProgress : THREE.MathUtils.lerp(progress, targetProgress, damping);
    dampedPointer.lerp(reduced ? new THREE.Vector2() : pointer, damping * .65);
    const state = feeJourney(reduced ? 0 : progress);
    // Camera response has inertia; the model never follows the pointer position.
    assembly.rotation.set(-dampedPointer.y * .065, dampedPointer.x * .095 - (mobile ? .025 : .085), -.015);
    assembly.position.y = Math.sin(elapsed * .45) * .025 + state.exit * (mobile ? 1 : 2.3);
    const distance = mobile ? 11.5 : Math.max(13.6, 19 / camera.aspect);
    camera.position.set(-dampedPointer.x * .1, .25 + dampedPointer.y * .08, distance - state.push * (mobile ? .2 : 1));
    camera.lookAt(mobile ? -.15 : 0, .2 - state.exit * .8, 0); camera.updateMatrixWorld();
    orb.group.position.copy(incoming.getPoint(state.incoming));
    orb.group.position.y += hover * dampedPointer.y * .018;
    orb.group.visible = state.orb > .001;
    orb.group.scale.setScalar((mobile ? .7 : 1) * state.orb * (1 + .035 * Math.sin(elapsed * 2) + hover * .07));
    orb.halo.material.opacity = .7 + hover * .25; orb.light.intensity = (4 + hover * 3) * state.orb;
    inlet.energyMaterial.opacity = .08 + hover * .1 + state.processing * .15;
    trail.update(state.incoming, .18, elapsed * (.3 + hover)); trail.points.visible = state.orb > .05;
    core.lightMaterial.opacity = .35 + state.processing * .65;
    core.inner.material.opacity = .8 - state.processing * .65;
    core.channels.scale.y = .6 + state.division * .4;
    coreLabel.style.opacity = `${1 - state.processing * .65}`;
    assembly.updateMatrixWorld(true);
    nodes.forEach((node, i) => {
      const focused = selected.current === i;
      const dim = selected.current >= 0 && !focused ? .25 : 1;
      const pulse = Math.sin(ramp(progress, .74, .86) * Math.PI) ** 2;
      node.lightMaterial.opacity = (.3 + state.arrival * .4 + pulse * .3 + (focused ? .3 : 0)) * dim;
      const route = routes[i];
      route.tube.energy.geometry.setDrawRange(0, Math.floor((route.tube.energy.geometry.index?.count ?? 0) * state.outgoing / 6) * 6);
      route.tube.energyMaterial.opacity = (.4 + shares[i] / 100 + (focused ? .3 : 0)) * dim;
      // Inspection illuminates the whole selected path, independent of scroll position.
      if (focused) route.tube.energy.geometry.setDrawRange(0, Infinity);
      route.particles.points.visible = state.outgoing > .01;
      route.particles.points.material.opacity = dim;
      route.particles.update(state.outgoing, .26 + shares[i] / 100, elapsed * .28);
      project(labels[i], node.group.position.clone().add(V(0, 0, .24)));
      labels[i]?.style.setProperty("--arrival", String(state.arrival));
      labels[i]?.style.setProperty("--route-dim", String(dim));
    });
    project(coreLabel, core.group.position.clone().add(V(0, 0, .6)));
    project(incomingLabel, incoming.getPoint(.36).add(V(0, .44, 0)));
    progressBar.style.transform = `scaleX(${progress})`;
    const phase = Math.min(4, Math.floor(progress * 5));
    phaseLabel.textContent = ["01 / A fee enters", "02 / Inside the core", "03 / Programmed to split", "04 / Every share delivered", "05 / Your rules. In motion."][phase];
    viewport.style.setProperty("--journey-exit", String(state.exit));
    renderer.render(scene, camera);
    if (!reduced || Math.abs(progress - targetProgress) > .001) wake();
  }
  function wake() { if (!disposed && visible && !document.hidden && !frameId) frameId = requestAnimationFrame(tick); }
  const visibility = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (visible) { lastTime = performance.now(); wake(); } else { cancelAnimationFrame(frameId); frameId = 0; } }); visibility.observe(viewport);
  const resizeObserver = new ResizeObserver(resize); resizeObserver.observe(container);
  const motionChange = () => { reduced = media.matches || document.documentElement.dataset.motion === "reduced"; wake(); };
  const motionObserver = new MutationObserver(motionChange); motionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
  media.addEventListener("change", motionChange);
  window.addEventListener("scroll", updateScroll, { passive: true });
  viewport.addEventListener("pointermove", onPointer, { passive: true }); viewport.addEventListener("pointerleave", onLeave); viewport.addEventListener("pointerup", onLeave);
  viewport.addEventListener("focusin", wake); viewport.addEventListener("focusout", wake); viewport.addEventListener("click", wake);
  document.addEventListener("visibilitychange", wake);
  const contextLost = (event: Event) => { event.preventDefault(); options.onFailure(); cancelAnimationFrame(frameId); frameId = 0; visible = false; };
  renderer.domElement.addEventListener("webglcontextlost", contextLost);
  resize(); options.onReady(); wake();
  return () => {
    disposed = true; cancelAnimationFrame(frameId); visibility.disconnect(); resizeObserver.disconnect(); motionObserver.disconnect();
    media.removeEventListener("change", motionChange); window.removeEventListener("scroll", updateScroll);
    viewport.removeEventListener("pointermove", onPointer); viewport.removeEventListener("pointerleave", onLeave); viewport.removeEventListener("pointerup", onLeave);
    viewport.removeEventListener("focusin", wake); viewport.removeEventListener("focusout", wake); viewport.removeEventListener("click", wake); document.removeEventListener("visibilitychange", wake);
    renderer.domElement.removeEventListener("webglcontextlost", contextLost);
    clearAssembly(); chrome.dispose(); glass.dispose(); glowTexture.dispose(); renderer.dispose(); renderer.domElement.remove();
  };
}
