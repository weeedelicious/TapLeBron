const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

// Resize in video pixels so rotated rectangles keep their opposite corner fixed
// on non-square sources. Clamp only when the resulting local box meets an edge.
export function resizeMaskBox(box,angle,corner,delta,width,height){
  const radians=angle*Math.PI/180,c=Math.cos(radians),s=Math.sin(radians);
  const dx=delta[0]*width,dy=delta[1]*height;
  const sx=[-1,1,1,-1][corner],sy=[-1,-1,1,1][corner];
  const oldW=(box[2]-box[0])*width,oldH=(box[3]-box[1])*height;
  const w=clamp(oldW+sx*(dx*c+dy*s),1,width),h=clamp(oldH+sy*(-dx*s+dy*c),1,height);
  const shiftX=sx*(w-oldW)/2,shiftY=sy*(h-oldH)/2;
  const x=clamp((box[0]+box[2])*width/2+shiftX*c-shiftY*s,w/2,width-w/2);
  const y=clamp((box[1]+box[3])*height/2+shiftX*s+shiftY*c,h/2,height-h/2);
  return [(x-w/2)/width,(y-h/2)/height,(x+w/2)/width,(y+h/2)/height];
}

export function numericMaskBox(box,field,value,width,height){
  if(!Number.isFinite(value))throw new Error('请输入有效数字');
  const w=box[2]-box[0],h=box[3]-box[1],b=[...box];
  if(field==='x'){b[0]=clamp(value/width,0,1-w);b[2]=b[0]+w;}
  if(field==='y'){b[1]=clamp(value/height,0,1-h);b[3]=b[1]+h;}
  if(field==='width')b[2]=b[0]+clamp(value/width,1/width,1-b[0]);
  if(field==='height')b[3]=b[1]+clamp(value/height,1/height,1-b[1]);
  return b;
}
