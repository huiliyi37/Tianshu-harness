<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { Renderer, Program, Mesh, Color, Triangle } from 'ogl'
import { useElementVisibility } from '@/composables/useElementVisibility'

const vertexShader = `
attribute vec2 uv;
attribute vec2 position;

varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position, 0, 1);
}
`

const fragmentShader = `
precision highp float;

uniform float uTime;
uniform vec3 uResolution;
uniform vec2 uFocal;
uniform vec2 uRotation;
uniform float uStarSpeed;
uniform float uDensity;
uniform float uHueShift;
uniform float uSpeed;
uniform vec2 uMouse;
uniform float uGlowIntensity;
uniform float uSaturation;
uniform bool uMouseRepulsion;
uniform bool uMouseAttraction;
uniform float uTwinkleIntensity;
uniform float uRotationSpeed;
uniform float uRepulsionStrength;
uniform float uMouseActiveFactor;
uniform float uAutoCenterRepulsion;
uniform bool uTransparent;

varying vec2 vUv;

#define NUM_LAYER 4.0
#define STAR_COLOR_CUTOFF 0.2
#define MAT45 mat2(0.7071, -0.7071, 0.7071, 0.7071)
#define PERIOD 3.0

float Hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float tri(float x) {
  return abs(fract(x) * 2.0 - 1.0);
}

float tris(float x) {
  float t = fract(x);
  return 1.0 - smoothstep(0.0, 1.0, abs(2.0 * t - 1.0));
}

float trisn(float x) {
  float t = fract(x);
  return 2.0 * (1.0 - smoothstep(0.0, 1.0, abs(2.0 * t - 1.0))) - 1.0;
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

float Star(vec2 uv, float flare) {
  float d = length(uv);
  float m = (0.05 * uGlowIntensity) / d;
  float rays = smoothstep(0.0, 1.0, 1.0 - abs(uv.x * uv.y * 1000.0));
  m += rays * flare * uGlowIntensity;
  uv *= MAT45;
  rays = smoothstep(0.0, 1.0, 1.0 - abs(uv.x * uv.y * 1000.0));
  m += rays * 0.3 * flare * uGlowIntensity;
  m *= smoothstep(1.0, 0.2, d);
  return m;
}

vec3 StarLayer(vec2 uv) {
  vec3 col = vec3(0.0);

  vec2 gv = fract(uv) - 0.5;
  vec2 id = floor(uv);

  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 offset = vec2(float(x), float(y));
      vec2 si = id + vec2(float(x), float(y));
      float seed = Hash21(si);
      float size = fract(seed * 345.32);
      float glossLocal = tri(uStarSpeed / (PERIOD * seed + 1.0));
      float flareSize = smoothstep(0.9, 1.0, size) * glossLocal;

      float red = smoothstep(STAR_COLOR_CUTOFF, 1.0, Hash21(si + 1.0)) + STAR_COLOR_CUTOFF;
      float blu = smoothstep(STAR_COLOR_CUTOFF, 1.0, Hash21(si + 3.0)) + STAR_COLOR_CUTOFF;
      float grn = min(red, blu) * seed;
      vec3 base = vec3(red, grn, blu);

      float hue = atan(base.g - base.r, base.b - base.r) / (2.0 * 3.14159) + 0.5;
      hue = fract(hue + uHueShift / 360.0);
      float sat = length(base - vec3(dot(base, vec3(0.299, 0.587, 0.114)))) * uSaturation;
      float val = max(max(base.r, base.g), base.b);
      base = hsv2rgb(vec3(hue, sat, val));

      vec2 pad = vec2(tris(seed * 34.0 + uTime * uSpeed / 10.0), tris(seed * 38.0 + uTime * uSpeed / 30.0)) - 0.5;

      float star = Star(gv - offset - pad, flareSize);
      vec3 color = base;

      float twinkle = trisn(uTime * uSpeed + seed * 6.2831) * 0.5 + 1.0;
      twinkle = mix(1.0, twinkle, uTwinkleIntensity);
      star *= twinkle;

      col += star * size * color;
    }
  }

  return col;
}

void main() {
  vec2 focalPx = uFocal * uResolution.xy;
  vec2 uv = (vUv * uResolution.xy - focalPx) / uResolution.y;

  vec2 mouseNorm = uMouse - vec2(0.5);

  if (uAutoCenterRepulsion > 0.0) {
    vec2 centerUV = vec2(0.0, 0.0);
    float centerDist = length(uv - centerUV);
    vec2 repulsion = normalize(uv - centerUV) * (uAutoCenterRepulsion / (centerDist + 0.1));
    uv += repulsion * 0.05;
  } else if (uMouseRepulsion) {
    vec2 mousePosUV = (uMouse * uResolution.xy - focalPx) / uResolution.y;
    float mouseDist = length(uv - mousePosUV);
    float mouseRange = 0.22;
    float influence = smoothstep(mouseRange, 0.0, mouseDist);
    if (influence > 0.0) {
      vec2 dir = normalize(uv - mousePosUV);
      if (uMouseAttraction) dir = -dir;
      vec2 force = dir * uRepulsionStrength * influence;
      uv += force * 0.05 * uMouseActiveFactor;
    }
  } else {
    vec2 mouseOffset = mouseNorm * 0.1 * uMouseActiveFactor;
    uv += mouseOffset;
  }

  float autoRotAngle = uTime * uRotationSpeed;
  mat2 autoRot = mat2(cos(autoRotAngle), -sin(autoRotAngle), sin(autoRotAngle), cos(autoRotAngle));
  uv = autoRot * uv;

  uv = mat2(uRotation.x, -uRotation.y, uRotation.y, uRotation.x) * uv;

  vec3 col = vec3(0.0);

  for (float i = 0.0; i < 1.0; i += 1.0 / NUM_LAYER) {
    float depth = fract(i + uStarSpeed * uSpeed);
    float scale = mix(20.0 * uDensity, 0.5 * uDensity, depth);
    float fade = depth * smoothstep(1.0, 0.9, depth);
    col += StarLayer(uv * scale + i * 453.32) * fade;
  }

  if (uTransparent) {
    float alpha = length(col);
    alpha = smoothstep(0.0, 0.3, alpha);
    alpha = min(alpha, 1.0);
    gl_FragColor = vec4(col, alpha);
  } else {
    gl_FragColor = vec4(col, 1.0);
  }
}
`

interface GalaxyProps {
  focal?: [number, number]
  rotation?: [number, number]
  starSpeed?: number
  density?: number
  hueShift?: number
  disableAnimation?: boolean
  speed?: number
  mouseInteraction?: boolean
  glowIntensity?: number
  saturation?: number
  mouseRepulsion?: boolean
  mouseAttraction?: boolean
  repulsionStrength?: number
  twinkleIntensity?: number
  rotationSpeed?: number
  autoCenterRepulsion?: number
  transparent?: boolean
}

const props = withDefaults(defineProps<GalaxyProps>(), {
  focal: () => [0.5, 0.5],
  rotation: () => [1.0, 0.0],
  starSpeed: 0.5,
  density: 1,
  hueShift: 140,
  disableAnimation: false,
  speed: 1.0,
  mouseInteraction: true,
  glowIntensity: 0.3,
  saturation: 0.0,
  mouseRepulsion: true,
  mouseAttraction: true,
  repulsionStrength: 2,
  twinkleIntensity: 0.3,
  rotationSpeed: 0.1,
  autoCenterRepulsion: 0,
  transparent: true,
})

const ctnDom = ref<HTMLDivElement | null>(null)
const isVisible = useElementVisibility(ctnDom)
let isAnimating = false

let renderer: Renderer | null = null
let gl: Renderer['gl'] | null = null
let program: Program | null = null
let mesh: Mesh | null = null
let animateId = 0
let canvas: HTMLCanvasElement | null = null
let resizeHandler: (() => void) | null = null
let handleMouseMove: ((e: MouseEvent) => void) | null = null
let handleMouseLeave: (() => void) | null = null

const targetMousePos = { x: 0.5, y: 0.5 }
const smoothMousePos = { x: 0.5, y: 0.5 }
let targetMouseActive = 0.0
let smoothMouseActive = 0.0

function update(t: number) {
  if (!program || !mesh || !renderer || !isVisible.value) {
    isAnimating = false
    return
  }
  animateId = requestAnimationFrame(update)
  if (!props.disableAnimation) {
    program.uniforms.uTime.value = t * 0.001
    program.uniforms.uStarSpeed.value = (t * 0.001 * props.starSpeed) / 10.0
  }

  const lerpFactor = 0.25
  smoothMousePos.x += (targetMousePos.x - smoothMousePos.x) * lerpFactor
  smoothMousePos.y += (targetMousePos.y - smoothMousePos.y) * lerpFactor
  smoothMouseActive += (targetMouseActive - smoothMouseActive) * lerpFactor

  program.uniforms.uMouse.value[0] = smoothMousePos.x
  program.uniforms.uMouse.value[1] = smoothMousePos.y
  program.uniforms.uMouseActiveFactor.value = smoothMouseActive

  renderer.render({ scene: mesh })
}

onMounted(() => {
  if (!ctnDom.value) return
  const ctn = ctnDom.value

  renderer = new Renderer({
    alpha: props.transparent,
    premultipliedAlpha: false,
  })
  gl = renderer.gl

  if (props.transparent) {
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.clearColor(0, 0, 0, 0)
  } else {
    gl.clearColor(0, 0, 0, 1)
  }

  resizeHandler = () => {
    if (!renderer || !gl) return
    const dpr = Math.min(window.devicePixelRatio || 1, 1)
    renderer.setSize(ctn.offsetWidth * dpr, ctn.offsetHeight * dpr)
    if (program) {
      program.uniforms.uResolution.value = new Color(
        gl.canvas.width,
        gl.canvas.height,
        gl.canvas.width / gl.canvas.height
      )
    }
  }

  window.addEventListener('resize', resizeHandler, false)
  resizeHandler()

  const geometry = new Triangle(gl)
  program = new Program(gl, {
    vertex: vertexShader,
    fragment: fragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uResolution: {
        value: new Color(
          gl.canvas.width,
          gl.canvas.height,
          gl.canvas.width / gl.canvas.height
        ),
      },
      uFocal: { value: new Float32Array(props.focal) },
      uRotation: { value: new Float32Array(props.rotation) },
      uStarSpeed: { value: props.starSpeed },
      uDensity: { value: props.density },
      uHueShift: { value: props.hueShift },
      uSpeed: { value: props.speed },
      uMouse: { value: new Float32Array([0.5, 0.5]) },
      uGlowIntensity: { value: props.glowIntensity },
      uSaturation: { value: props.saturation },
      uMouseRepulsion: { value: props.mouseRepulsion },
      uMouseAttraction: { value: props.mouseAttraction },
      uTwinkleIntensity: { value: props.twinkleIntensity },
      uRotationSpeed: { value: props.rotationSpeed },
      uRepulsionStrength: { value: props.repulsionStrength },
      uMouseActiveFactor: { value: 0.0 },
      uAutoCenterRepulsion: { value: props.autoCenterRepulsion },
      uTransparent: { value: props.transparent },
    },
  })

  resizeHandler()

  mesh = new Mesh(gl, { geometry, program })

  // Start animation only when visible
  if (isVisible.value) {
    isAnimating = true
    animateId = requestAnimationFrame(update)
  }
  canvas = gl.canvas as HTMLCanvasElement
  ctn.appendChild(canvas)

  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.position = 'absolute'
  canvas.style.top = '0'
  canvas.style.left = '0'
  canvas.style.pointerEvents = 'none'

  function updateMousePos(e: MouseEvent) {
    const rect = ctn.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = 1.0 - (e.clientY - rect.top) / rect.height
    targetMousePos.x = Math.max(0, Math.min(1, x))
    targetMousePos.y = Math.max(0, Math.min(1, y))
  }

  function isInsideContainer(e: MouseEvent) {
    const rect = ctn.getBoundingClientRect()
    return (
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom
    )
  }

  handleMouseMove = (e: MouseEvent) => {
    if (!isInsideContainer(e)) {
      targetMouseActive = 0.0
      return
    }
    updateMousePos(e)
    targetMouseActive = 1.0
  }

  handleMouseLeave = () => {
    targetMouseActive = 0.0
  }

  if (props.mouseInteraction) {
    window.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseleave', handleMouseLeave)
  }
})

watch(isVisible, (visible) => {
  if (visible && !isAnimating && renderer) {
    isAnimating = true
    animateId = requestAnimationFrame(update)
  }
})

onUnmounted(() => {
  cancelAnimationFrame(animateId)
  if (resizeHandler) window.removeEventListener('resize', resizeHandler)
  if (props.mouseInteraction) {
    if (handleMouseMove) window.removeEventListener('mousemove', handleMouseMove)
    if (handleMouseLeave) document.removeEventListener('mouseleave', handleMouseLeave)
  }
  const ctn = ctnDom.value
  if (canvas && ctn) ctn.removeChild(canvas)
  gl?.getExtension('WEBGL_lose_context')?.loseContext()
})
</script>

<template>
  <div
    ref="ctnDom"
    class="pointer-events-none absolute inset-0 z-0"
    aria-hidden="true"
  />
</template>
