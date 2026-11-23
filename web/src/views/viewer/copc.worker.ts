import { createLazPerf } from 'laz-perf/lib/worker';
import wasm from 'laz-perf/lib/worker/laz-perf.wasm?url';
import type { ChunkRequest } from './local-copc';
import { readRange } from './copc-source';

const decoder = createLazPerf({locateFile: () => wasm});
let colorShift: number | undefined;
onmessage = async ({data}: MessageEvent<ChunkRequest>) => {
  try {
    const {file,header,record,center} = data;
    const bytes = new Uint8Array(await readRange(file,record.pointDataOffset,record.pointDataOffset+record.pointDataLength));
    const lib = await decoder, size = header.pointDataRecordLength;
    const input = lib._malloc(bytes.length), point = lib._malloc(size);
    const reader = new lib.ChunkDecoder();
    try {
      lib.HEAPU8.set(bytes,input);
      reader.open(header.pointDataRecordFormat,size,input);
      const positions = new Float32Array(record.pointCount*3);
      const colors = header.pointDataRecordFormat >= 7 ? new Uint8Array(record.pointCount*4) : undefined;
      const firstColors = colors && colorShift===undefined ? new Uint16Array(record.pointCount*3) : undefined;
      let peak=0;
      let heap = lib.HEAPU8.buffer, view = new DataView(heap,point,size);
      for (let i=0;i<record.pointCount;i++) {
        reader.getPoint(point);
        if (heap !== lib.HEAPU8.buffer) { heap=lib.HEAPU8.buffer; view=new DataView(heap,point,size); }
        for (let j=0;j<3;j++) {
          positions[i*3+j]=view.getInt32(j*4,true)*header.scale[j]+(header.offset[j]-center[j]);
          if (colors) {
            const channel=view.getUint16(30+j*2,true);
            if (firstColors) { firstColors[i*3+j]=channel; peak=Math.max(peak,channel); }
            else colors[i*4+j]=channel >> (colorShift ?? 8);
          }
        }
        if (colors) colors[i*4+3]=255;
      }
      if (colors && firstColors && peak) {
        colorShift=peak>255 ? 8 : 0;
        for (let i=0;i<record.pointCount;i++)
          for (let j=0;j<3;j++) colors[i*4+j]=firstColors[i*3+j] >> colorShift;
      }
      postMessage({positions,colors},{transfer:colors ? [positions.buffer,colors.buffer] : [positions.buffer]});
    } finally { reader.delete(); lib._free(point); lib._free(input); }
  } catch (error) { postMessage({error:String(error)}); }
};
