/**
 * 帧混合用的 GPU 渲染器。
 * 前帧不透明铺底，后帧按预览同一个 alpha 盖上去。
 * WebGL 贴不上 VideoFrame 时退回 Canvas2D，方向和混合结果保持一致。
 */
export class WebGLFrameRenderer {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.use2d = false;

    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;

    this.canvas2d = document.createElement('canvas');
    this.canvas2d.width = width;
    this.canvas2d.height = height;
    this.ctx = this.canvas2d.getContext('2d', { alpha: false });

    const gl = this.canvas.getContext('webgl2', {
      preserveDrawingBuffer: true,
      alpha: false,
      antialias: false,
      depth: false
    });
    this.gl = gl;
    if (!gl || !this.initShaders() || !this.initBuffers()) {
      this.use2d = true;
    }
  }

  initShaders() {
    const gl = this.gl;
    const vsSource = `
      attribute vec2 a_position;
      attribute vec2 a_texCoord;
      varying vec2 v_texCoord;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = a_texCoord;
      }
    `;
    const fsSource = `
      precision mediump float;
      varying vec2 v_texCoord;
      uniform sampler2D u_texture;
      uniform float u_alpha;
      void main() {
        vec4 color = texture2D(u_texture, v_texCoord);
        gl_FragColor = vec4(color.rgb, color.a * u_alpha);
      }
    `;

    const vs = this.compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return false;

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;

    this.program = program;
    gl.useProgram(program);
    this.positionLoc = gl.getAttribLocation(program, 'a_position');
    this.texCoordLoc = gl.getAttribLocation(program, 'a_texCoord');
    this.textureLoc = gl.getUniformLocation(program, 'u_texture');
    this.alphaLoc = gl.getUniformLocation(program, 'u_alpha');

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.viewport(0, 0, this.width, this.height);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    return true;
  }

  compileShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return null;
    return shader;
  }

  initBuffers() {
    const gl = this.gl;
    const vertices = new Float32Array([
      -1, -1, 0, 1,
      1, -1, 1, 1,
      -1, 1, 0, 0,
      1, 1, 1, 0
    ]);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    gl.vertexAttribPointer(this.positionLoc, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(this.positionLoc);
    gl.vertexAttribPointer(this.texCoordLoc, 2, gl.FLOAT, false, 16, 8);
    gl.enableVertexAttribArray(this.texCoordLoc);

    this.textures = [this.createTexture(), this.createTexture()];
    gl.uniform1i(this.textureLoc, 0);
    return Boolean(this.textures[0]);
  }

  createTexture() {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return texture;
  }

  /**
   * @param {CanvasImageSource} frame
   */
  renderFrame(frame) {
    if (this.use2d) {
      this.paint2d(frame, null, 0);
      return;
    }
    try {
      this.paintGpu(frame, null, 0);
    } catch (err) {
      this.use2d = true;
      this.paint2d(frame, null, 0);
    }
  }

  /**
   * 前帧全不透明，后帧按 alpha 叠加。alpha 为 0 时只有前帧。
   * @param {CanvasImageSource} prevFrame
   * @param {CanvasImageSource|null} nextFrame
   * @param {number} alpha
   */
  renderBlend(prevFrame, nextFrame, alpha) {
    if (this.use2d) {
      this.paint2d(prevFrame, nextFrame, alpha);
      return;
    }
    try {
      this.paintGpu(prevFrame, nextFrame, alpha);
    } catch (err) {
      this.use2d = true;
      this.paint2d(prevFrame, nextFrame, alpha);
    }
  }

  paintGpu(prevFrame, nextFrame, alpha) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.upload(this.textures[0], prevFrame);
    gl.uniform1f(this.alphaLoc, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    if (nextFrame && alpha > 0) {
      this.upload(this.textures[1], nextFrame);
      gl.uniform1f(this.alphaLoc, alpha);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  upload(texture, source) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) {
      throw new Error(`WebGL 贴图失败: ${error}`);
    }
  }

  paint2d(prevFrame, nextFrame, alpha) {
    const ctx = this.ctx;
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.drawImage(prevFrame, 0, 0, this.width, this.height);
    if (nextFrame && alpha > 0) {
      ctx.globalAlpha = alpha;
      ctx.drawImage(nextFrame, 0, 0, this.width, this.height);
      ctx.globalAlpha = 1;
    }
  }

  /**
   * @param {number} timestamp 微秒
   * @param {number} duration 微秒
   * @returns {VideoFrame}
   */
  capture(timestamp, duration) {
    return new VideoFrame(this.use2d ? this.canvas2d : this.canvas, { timestamp, duration });
  }

  destroy() {
    const gl = this.gl;
    if (!gl || this.use2d) return;
    this.textures?.forEach((texture) => gl.deleteTexture(texture));
    if (this.program) gl.deleteProgram(this.program);
  }
}
