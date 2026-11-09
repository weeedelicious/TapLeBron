import path from 'node:path';

const folders={source:'source',raw:'raw-union',repair:'combined-repair',covered:'black-preview'};
export function draftFramePath(directory,kind,frame,layout){
  if(!Object.hasOwn(folders,kind)||!Number.isSafeInteger(frame)||frame<0)throw new Error('Invalid draft frame');
  if(layout==='component-native-v1')return path.join(directory,folders[kind],`v03-${String(frame).padStart(3,'0')}.png`);
  if(layout!=null)throw new Error('Unknown draft frame layout');
  return path.join(directory,'frames',kind,`${String(frame).padStart(6,'0')}.png`);
}
