import fs from 'node:fs';
import path from 'node:path';

function readPinnedModel(root, file, label) {
  const full=path.join(root,'server',file);
  if(!fs.existsSync(full))return {available:false};
  const model=JSON.parse(fs.readFileSync(full,'utf8'));
  const weights=path.resolve(root,model.weights),runtime=path.resolve(root,model.runtime);
  for(const target of [weights,runtime]){
    const relative=path.relative(root,target);
    if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error(`${label}配置路径无效`);
  }
  const python=process.env.WXHB_UI_PYTHON||path.join(runtime,process.platform==='win32'?'Scripts/python.exe':'bin/python');
  return {...model,python,available:fs.existsSync(weights)&&fs.existsSync(python)};
}

export function maskDetectorConfig(root) {
  return readPinnedModel(root,'ui_mask_model.json','辅助识别模型');
}

export function maskPanelConfig(root) {
  return readPinnedModel(root,'ui_mask_panel.json','赛事整板模型');
}

export function effectiveMaskDetector(requested='auto', category='static') {
  if(requested==='rules')return 'rules';
  if(requested==='trained')return 'trained';
  if(requested==='panel')return 'panel';
  if(requested!=='auto')throw new Error('识别方式无效');
  return category==='dynamic'?'auto':'panel';
}

export function resolveMaskDetector(root, requested='auto') {
  if(!['auto','trained','rules','panel'].includes(requested))throw new Error('识别方式无效');
  if(requested==='panel'){
    const panel=maskPanelConfig(root);
    if(panel.available)return {detector:'panel',detectorRequested:'panel',modelVersion:panel.version};
    const config=maskDetectorConfig(root);
    if(!config.available)throw new Error('赛事整板模型未安装，本机 AI 模型也不可用，可选择基础识别或直接手画遮罩');
    return {detector:'trained',detectorRequested:'panel',modelVersion:config.version,
      notice:`赛事整板权重未安装，本次静态识别改用本机 AI 模型 ${config.version}`};
  }
  const config=maskDetectorConfig(root);
  if(requested==='trained'&&!config.available)throw new Error('本机 AI 模型未安装，可选择基础识别或直接手画遮罩');
  const detector=requested!=='rules'&&config.available?'trained':'rules';
  return {detector,detectorRequested:requested,modelVersion:detector==='trained'?config.version:null};
}

export function maskExperimentConfig(root, version=null) {
  const file=path.join(root,'server','ui_mask_experiment.json');
  if(!fs.existsSync(file))return {available:false};
  const registry=JSON.parse(fs.readFileSync(file,'utf8'));
  const {alternatives=[],...primary}=registry;
  const model=version===null?primary:[primary,...alternatives].find(item=>item.version===version);
  if(!model)throw new Error('实验模型版本未登记');
  const targets=[model.weights,model.initialization,model.runtime].map(value=>path.resolve(root,value));
  for(const target of targets){
    const relative=path.relative(root,target);
    if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('实验模型配置路径无效');
  }
  const python=(model.backend==='text-component-association'||model.useServiceRuntime===true)&&process.env.WXHB_UI_PYTHON
    ?process.env.WXHB_UI_PYTHON:path.join(targets[2],process.platform==='win32'?'Scripts/python.exe':'bin/python');
  return {...model,python,available:targets.slice(0,2).every(file=>fs.existsSync(file))&&fs.existsSync(python)};
}

export function maskExperimentModels(root) {
  const file=path.join(root,'server','ui_mask_experiment.json');
  if(!fs.existsSync(file))return [];
  const registry=JSON.parse(fs.readFileSync(file,'utf8'));
  return [registry,...(registry.alternatives||[])].map(model=>maskExperimentConfig(root,model.version));
}
