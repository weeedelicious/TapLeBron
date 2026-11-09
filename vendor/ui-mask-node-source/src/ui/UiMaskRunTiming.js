// Monotonic client timing. Backend elapsed overlaps these stages; never add it.
import { randomUUID } from '../utils/randomUUID.js';
export class UiMaskRunTiming {
  constructor(mode='run',clock=()=>performance.now(),hidden=false){
    this.mode=mode;this.clock=clock;this.start=clock();this.startedAt=Date.now();this.marks={};this.hiddenMs=0;this.hiddenSince=hidden?this.start:null;this.sequence=0;
    this.runId=randomUUID();
  }
  mark(name){if(this.stopped==null&&this.marks[name]==null)this.marks[name]=this.clock()-this.start;}
  stop(){if(this.marks.visible==null&&this.stopped==null){this.visibility(false);this.stopped=this.clock()-this.start;}}
  visibility(hidden){
    if(this.marks.visible!=null||this.stopped!=null)return;
    if(hidden&&this.hiddenSince==null)this.hiddenSince=this.clock();
    else if(!hidden&&this.hiddenSince!=null){this.hiddenMs+=this.clock()-this.hiddenSince;this.hiddenSince=null;}
  }
  snapshot(){
    const elapsed=this.marks.visible??this.stopped??this.clock()-this.start;
    const between=(a,b)=>this.marks[b]==null?null:(this.marks[b]-(a?this.marks[a]??0:0))/1000;
    return {runId:this.runId,sequence:++this.sequence,mode:this.mode,startedAt:this.startedAt,completed:this.marks.visible!=null,
      totalSeconds:elapsed/1000,inputSeconds:between(null,'input'),allocationSeconds:between('input','created'),
      uploadSeconds:between('created','uploaded'),waitSeconds:between(this.mode==='run'?'uploaded':null,'ready'),
      decodeSeconds:between('ready','decoded'),paintSeconds:between('decoded','visible'),
      hiddenSeconds:(this.hiddenMs+(this.hiddenSince==null?0:this.clock()-this.hiddenSince))/1000,
      backendSeconds:this.backendSeconds??null,resultPickupSeconds:this.resultPickupSeconds??null};
  }
  text(){
    const s=this.snapshot(),fmt=n=>Number.isFinite(n)?`${n.toFixed(1)}秒`:'—';
    const prefix=this.mode==='run'?'本次运行总等待':'本次打开结果';
    const stages=this.mode==='run'?` · 输入 ${fmt(s.inputSeconds)} · 建任务 ${fmt(s.allocationSeconds)} · 上传 ${fmt(s.uploadSeconds)} · 等待结果 ${fmt(s.waitSeconds)}`:` · 获取结果 ${fmt(s.waitSeconds)}`;
    return `${prefix} ${fmt(s.totalSeconds)}${s.completed?'':this.stopped!=null?'（已停止）':'（进行中）'}${stages} · 图片 ${fmt(s.decodeSeconds)} · 显示等待 ${fmt(s.paintSeconds)} · 页面隐藏 ${fmt(s.hiddenSeconds)}。后台计算 ${fmt(s.backendSeconds)}；完成后等待状态查询 ${fmt(s.resultPickupSeconds)}（均已包含在等待中）。`;
  }
}
