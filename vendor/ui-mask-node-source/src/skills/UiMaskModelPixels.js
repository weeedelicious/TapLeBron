// Same order as the CPU exporter: model minus erasures, plus manual UI, one 4px allowance.
export function composeModelPixels(raw,add,erase,width,height,margin=4){
  const n=width*height,combined=new Uint8Array(n),horizontal=new Uint8Array(n),result=new Uint8Array(n);
  if([raw,add,erase].some(a=>a.length!==n))throw new Error('遮罩像素尺寸不一致');
  for(let i=0;i<n;i++)combined[i]=((raw[i]&&!erase[i])||add[i])?1:0;
  for(let y=0;y<height;y++){
    const offset=y*width;let count=0;
    for(let x=0;x<=margin&&x<width;x++)count+=combined[offset+x];
    for(let x=0;x<width;x++){
      horizontal[offset+x]=count?1:0;
      if(x-margin>=0)count-=combined[offset+x-margin];
      if(x+margin+1<width)count+=combined[offset+x+margin+1];
    }
  }
  for(let x=0;x<width;x++){
    let count=0;for(let y=0;y<=margin&&y<height;y++)count+=horizontal[y*width+x];
    for(let y=0;y<height;y++){
      result[y*width+x]=count?255:0;
      if(y-margin>=0)count-=horizontal[(y-margin)*width+x];
      if(y+margin+1<height)count+=horizontal[(y+margin+1)*width+x];
    }
  }
  return result;
}
