/**
 * 节点基类 - LibTV式内联参数版
 * 所有参数直接渲染在节点内部，自带右侧加号添加按钮
 * 每个Skill只需声明端口和参数，自动生成完整节点UI
 */
export class BaseNode {
  constructor(id, type, x, y) {
    this.id = id;
    this.type = type;
    this.x = x;
    this.y = y;
    this.width = 220;
    this.baseHeight = 44;
    this.paramHeight = 0;

    this.inputs = [];
    this.outputs = [];
    this.params = {};
    this.outputData = null;
    this.executed = false;
    this.element = null;
  }

  addInput(name, type) {
    this.inputs.push({ name, type, connectedFrom: null });
  }

  addOutput(name, type) {
    this.outputs.push({ name, type });
  }

  addParam(key, label, defaultValue, control = 'text', options = []) {
    this.params[key] = { label, value: defaultValue, control, options };
    this.paramHeight += 36;
  }

  getParam(key) {
    return this.params[key]?.value;
  }

  setParam(key, value) {
    if (this.params[key]) {
      this.params[key].value = value;
      this.executed = false;
      window.editor?._scheduleSave?.();
    }
  }

  getInput(name) {
    const port = this.inputs.find(p => p.name === name);
    if (!port || !port.connectedFrom) return null;
    return port.connectedFrom.node.getOutput(port.connectedFrom.portName);
  }

  getOutput(name = 'default') {
    if (!this.executed) {
      this.execute();
      this.executed = true;
    }
    return this.outputData?.[name];
  }

  execute() {
    this.outputData = { default: null };
  }

  reset() {
    this.executed = false;
    this.outputData = null;
  }

  getHeight() {
    const portCount = Math.max(this.inputs.length, this.outputs.length);
    const portHeight = portCount * 28;
    return this.baseHeight + this.paramHeight + portHeight + 16;
  }

  dispose() {
    // 子类重写实现清理逻辑，基类默认空实现
    if (this.element && this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
  }
}
