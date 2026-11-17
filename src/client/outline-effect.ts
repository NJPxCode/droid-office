import * as THREE from 'three';

export interface OutlineEffectParameters {
  defaultThickness?: number;
  defaultColor?: number[];
  defaultAlpha?: number;
  defaultKeepAlive?: boolean;
  autoClear?: boolean;
}

interface OutlineUserData {
  visible?: boolean;
  thickness?: number;
  color?: number[];
  alpha?: number;
  keepAlive?: boolean;
}

interface SwappedMulti {
  mesh: THREE.Mesh;
  materials: THREE.Material[];
  hook: THREE.Object3D['onBeforeRender'];
}

const VERTEX_SHADER = [
  '#include <common>',
  '#include <uv_pars_vertex>',
  '#include <displacementmap_pars_vertex>',
  '#include <fog_pars_vertex>',
  '#include <morphtarget_pars_vertex>',
  '#include <skinning_pars_vertex>',
  '#include <logdepthbuf_pars_vertex>',
  '#include <clipping_planes_pars_vertex>',
  'uniform float outlineThickness;',
  'vec4 calculateOutline( vec4 pos, vec3 normal, vec4 skinned ) {',
  '\tfloat thickness = outlineThickness;',
  '\tconst float ratio = 1.0;',
  '\tvec4 pos2 = projectionMatrix * modelViewMatrix * vec4( skinned.xyz + normal, 1.0 );',
  '\tvec4 norm = normalize( pos - pos2 );',
  '\treturn pos + norm * thickness * pos.w * ratio;',
  '}',
  'void main() {',
  '\t#include <uv_vertex>',
  '\t#include <beginnormal_vertex>',
  '\t#include <morphnormal_vertex>',
  '\t#include <skinbase_vertex>',
  '\t#include <skinnormal_vertex>',
  '\t#include <begin_vertex>',
  '\t#include <morphtarget_vertex>',
  '\t#include <skinning_vertex>',
  '\t#include <displacementmap_vertex>',
  '\t#include <project_vertex>',
  '\tvec3 outlineNormal = - objectNormal;',
  '\tgl_Position = calculateOutline( gl_Position, outlineNormal, vec4( transformed, 1.0 ) );',
  '\t#include <logdepthbuf_vertex>',
  '\t#include <clipping_planes_vertex>',
  '\t#include <fog_vertex>',
  '}',
].join('\n');

const FRAGMENT_SHADER = [
  '#include <common>',
  '#include <fog_pars_fragment>',
  '#include <logdepthbuf_pars_fragment>',
  '#include <clipping_planes_pars_fragment>',
  'uniform vec3 outlineColor;',
  'uniform float outlineAlpha;',
  'void main() {',
  '\t#include <clipping_planes_fragment>',
  '\t#include <logdepthbuf_fragment>',
  '\tgl_FragColor = vec4( outlineColor, outlineAlpha );',
  '\t#include <tonemapping_fragment>',
  '\t#include <colorspace_fragment>',
  '\t#include <fog_fragment>',
  '\t#include <premultiplied_alpha_fragment>',
  '}',
].join('\n');

const HIDDEN_OUTLINE = new THREE.MeshBasicMaterial({ visible: false });

function isCompatible(object: THREE.Object3D): object is THREE.Mesh {
  const mesh = object as THREE.Mesh;
  return mesh.isMesh === true && mesh.material !== undefined && mesh.geometry?.attributes.normal !== undefined;
}

function shouldOutline(original: THREE.Material): boolean {
  if (!original.visible || original.name === 'invisible') return false;
  if ((original as THREE.MeshBasicMaterial).wireframe === true || original.depthTest === false) return false;
  const params = original.userData?.outlineParameters as OutlineUserData | undefined;
  return params?.visible !== false;
}

function updateUniforms(material: THREE.ShaderMaterial, original: THREE.Material, defaultThickness: number, defaultColor: THREE.Color) {
  const params = original.userData?.outlineParameters as OutlineUserData | undefined;
  material.uniforms.outlineThickness.value = params?.thickness ?? defaultThickness;
  if (params?.color !== undefined) material.uniforms.outlineColor.value.fromArray(params.color);
  else material.uniforms.outlineColor.value.copy(defaultColor);
  material.uniforms.outlineAlpha.value = params?.alpha ?? original.opacity;
  const disp = original as THREE.MeshStandardMaterial;
  if (disp.displacementMap) {
    material.uniforms.displacementMap.value = disp.displacementMap;
    material.uniforms.displacementScale.value = disp.displacementScale;
    material.uniforms.displacementBias.value = disp.displacementBias;
  }
}

function syncOutlineMaterial(material: THREE.ShaderMaterial, original: THREE.Material) {
  const params = original.userData?.outlineParameters as OutlineUserData | undefined;
  const disp = original as THREE.MeshStandardMaterial;
  material.fog = (original as THREE.MeshToonMaterial).fog === true;
  material.toneMapped = original.toneMapped;
  material.premultipliedAlpha = original.premultipliedAlpha;
  (material as THREE.ShaderMaterial & { displacementMap?: THREE.Texture | null }).displacementMap = disp.displacementMap ?? null;
  material.transparent = params?.alpha !== undefined && params.alpha < 1.0 ? true : original.transparent;
  material.visible = true;
  if (original.clippingPlanes) {
    material.clipping = true;
    material.clippingPlanes = original.clippingPlanes;
    material.clipIntersection = original.clipIntersection;
    material.clipShadows = original.clipShadows;
  } else {
    material.clipping = false;
    material.clippingPlanes = null;
  }
  if (material.userData.sourceVersion !== original.version) {
    material.userData.sourceVersion = original.version;
    material.needsUpdate = true;
  }
}

/**
 * Drop-in replacement for Three.js `OutlineEffect` with identical toon-outline GLSL shaders,
 * optimized for Droid Office:
 * - Traverses only visible subtrees (`scene.traverseVisible`), skipping hidden `roof` / `office` / `beanbag` graphs.
 * - Uses a `WeakMap` material cache so pre-warmed outline programs are never evicted after 60 frames and
 *   per-frame `Object.keys()` cache sweeps are eliminated.
 * - Shares a single non-visible sentinel material for `outlineParameters.visible === false` meshes instead of
 *   allocating unused `ShaderMaterial`s and `onBeforeRender` hooks.
 */
export class OutlineEffect {
  enabled = true;
  autoClear: boolean;

  private defaultThickness: number;
  private readonly defaultColor: THREE.Color;
  private defaultAlpha: number;
  private readonly cache = new WeakMap<THREE.Material, THREE.ShaderMaterial>();

  private readonly swappedMeshes: THREE.Mesh[] = [];
  private readonly swappedMaterials: THREE.Material[] = [];
  private readonly swappedHooks: Array<THREE.Object3D['onBeforeRender'] | null> = [];
  private readonly swappedMulti: SwappedMulti[] = [];

  private readonly handleBeforeRender: THREE.Object3D['onBeforeRender'];

  constructor(
    private readonly renderer: {
      autoClear: boolean;
      shadowMap: { enabled: boolean };
      render(scene: THREE.Object3D, camera: THREE.Camera): void;
      setSize(width: number, height: number, updateStyle?: boolean): void;
    },
    parameters: OutlineEffectParameters = {},
  ) {
    this.defaultThickness = parameters.defaultThickness ?? 0.003;
    this.defaultColor = new THREE.Color().fromArray(parameters.defaultColor ?? [0, 0, 0]);
    this.defaultAlpha = parameters.defaultAlpha ?? 1.0;
    this.autoClear = parameters.autoClear ?? false;

    this.handleBeforeRender = (_renderer, _scene, _camera, _geometry, material) => {
      const shaderMat = material as THREE.ShaderMaterial;
      const original = shaderMat.userData?.originalMaterial as THREE.Material | undefined;
      if (original) updateUniforms(shaderMat, original, this.defaultThickness, this.defaultColor);
    };
  }

  private createOutlineMaterial(): THREE.ShaderMaterial {
    const material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        THREE.UniformsLib.displacementmap,
        {
          outlineThickness: { value: this.defaultThickness },
          outlineColor: { value: this.defaultColor.clone() },
          outlineAlpha: { value: this.defaultAlpha },
        },
      ]),
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      side: THREE.BackSide,
    });
    (material as { type: string }).type = 'OutlineEffect';
    return material;
  }

  private resolveOutlineMaterial(original: THREE.Material): THREE.Material {
    if (!shouldOutline(original)) return HIDDEN_OUTLINE;
    let outline = this.cache.get(original);
    if (!outline) {
      outline = this.createOutlineMaterial();
      this.cache.set(original, outline);
    }
    outline.userData.originalMaterial = original;
    syncOutlineMaterial(outline, original);
    return outline;
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (!this.enabled) {
      this.renderer.render(scene, camera);
      return;
    }
    const currentAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = this.autoClear;
    try {
      this.renderer.render(scene, camera);
    } finally {
      this.renderer.autoClear = currentAutoClear;
    }
    this.renderOutline(scene, camera);
  }

  renderOutline(scene: THREE.Scene, camera: THREE.Camera): void {
    const currentAutoClear = this.renderer.autoClear;
    const currentSceneAutoUpdate = scene.matrixWorldAutoUpdate;
    const currentSceneBackground = scene.background;
    const currentShadowMapEnabled = this.renderer.shadowMap.enabled;

    scene.matrixWorldAutoUpdate = false;
    scene.background = null;
    this.renderer.autoClear = false;
    this.renderer.shadowMap.enabled = false;

    let singleCount = 0;
    let multiCount = 0;

    scene.traverseVisible((object) => {
      if (!isCompatible(object)) return;
      const mat = object.material;
      if (Array.isArray(mat)) {
        const saved = mat.slice();
        let anyOutlined = false;
        for (let i = 0; i < mat.length; i++) {
          const next = this.resolveOutlineMaterial(mat[i]);
          if (next !== HIDDEN_OUTLINE) anyOutlined = true;
          mat[i] = next;
        }
        const prevHook = object.onBeforeRender;
        if (anyOutlined) object.onBeforeRender = this.handleBeforeRender;
        this.swappedMulti[multiCount++] = { mesh: object, materials: saved, hook: prevHook };
        return;
      }
      const next = this.resolveOutlineMaterial(mat);
      this.swappedMeshes[singleCount] = object;
      this.swappedMaterials[singleCount] = mat;
      if (next !== HIDDEN_OUTLINE) {
        this.swappedHooks[singleCount] = object.onBeforeRender;
        object.onBeforeRender = this.handleBeforeRender;
      } else {
        this.swappedHooks[singleCount] = null;
      }
      object.material = next;
      singleCount++;
    });

    try {
      this.renderer.render(scene, camera);
    } finally {
      for (let i = 0; i < singleCount; i++) {
        const mesh = this.swappedMeshes[i];
        mesh.material = this.swappedMaterials[i];
        const hook = this.swappedHooks[i];
        if (hook !== null) mesh.onBeforeRender = hook;
      }
      for (let i = 0; i < multiCount; i++) {
        const entry = this.swappedMulti[i];
        const arr = entry.mesh.material as THREE.Material[];
        arr.length = entry.materials.length;
        for (let j = 0; j < entry.materials.length; j++) arr[j] = entry.materials[j];
        entry.mesh.onBeforeRender = entry.hook;
      }
      this.swappedMeshes.length = 0;
      this.swappedMaterials.length = 0;
      this.swappedHooks.length = 0;
      this.swappedMulti.length = 0;

      scene.matrixWorldAutoUpdate = currentSceneAutoUpdate;
      scene.background = currentSceneBackground;
      this.renderer.autoClear = currentAutoClear;
      this.renderer.shadowMap.enabled = currentShadowMapEnabled;
    }
  }

  setDefaults(thickness: number, alpha = 1): void {
    this.defaultThickness = thickness;
    this.defaultAlpha = alpha;
  }

  setSize(width: number, height: number, updateStyle?: boolean): void {
    this.renderer.setSize(width, height, updateStyle);
  }
}
