import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPlyHeader } from './ply-header.ts';

const fields = ['x', 'y', 'z', 'opacity', 'f_dc_0', 'f_dc_1', 'f_dc_2',
  'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

test('reads a large PLY header without requesting the model body', async () => {
  const header = ['ply', 'format binary_little_endian 1.0', 'comment epsg 32650',
    'comment offsetx 1000.125', 'comment offsety 2000.5', 'comment offsetz 10',
    'comment source Qiyu', ...Array.from({ length: 3000 }, () => 'comment filler ignored'),
    'element vertex 123456', ...fields.map(field => `property float ${field}`), 'end_header', ''].join('\n');
  class HeaderOnlyFile extends File {
    override slice(start?: number, end?: number, contentType?: string): Blob {
      assert.ok((end ?? 0) <= 128 * 1024);
      return super.slice(start, end, contentType);
    }
  }
  const file = new HeaderOnlyFile([header, new Uint8Array(1024 * 1024)], 'model.ply');
  const metadata = await readPlyHeader(file);
  assert.equal(metadata.error, undefined);
  assert.equal(metadata.epsg, '32650');
  assert.deepEqual(metadata.offset, ['1000.125', '2000.5', '10']);
  assert.equal(metadata.count, 123456);
  assert.equal(metadata.source, 'Qiyu');
});

test('keeps missing projected origin empty without rejecting Gaussian PLY', async () => {
  const header = ['ply', 'format binary_little_endian 1.0', 'comment epsg 32650',
    'element vertex 1', ...fields.map(field => `property float ${field}`), 'end_header', ''].join('\n');
  const metadata = await readPlyHeader(new File([header], 'model.ply'));
  assert.equal(metadata.error, undefined);
  assert.deepEqual(metadata.offset, ['', '', '']);
});
