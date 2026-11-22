<script setup lang="ts">
const faces = [
  { axis: 'x', direction: '1,0,0', label: 'X', title: '沿 +X 查看' },
  { axis: 'nx', direction: '-1,0,0', label: '−X', title: '沿 -X 查看' },
  { axis: 'y', direction: '0,1,0', label: 'Y', title: '沿 +Y 查看' },
  { axis: 'ny', direction: '0,-1,0', label: '−Y', title: '沿 -Y 查看' },
  { axis: 'z', direction: '0,0,1', label: 'Z', title: '顶视图（沿 +Z 查看）' },
  { axis: 'nz', direction: '0,0,-1', label: '−Z', title: '底视图（沿 -Z 查看）' },
];
const corners = [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => ({
  direction: `${x},${y},${z}`,
  title: `斜视角 ${x > 0 ? '+' : '−'}X ${y > 0 ? '+' : '−'}Y ${z > 0 ? '+' : '−'}Z`,
}))));
</script>

<template>
  <div class="view-cube-scene"><div class="view-cube-scale"><div class="view-cube">
  <button v-for="face in faces" :key="face.axis" class="cube-face" :class="`face-${face.axis}`" :data-direction="face.direction" :title="face.title">{{ face.label }}</button>
  <button v-for="corner in corners" :key="corner.direction" class="cube-corner" :data-direction="corner.direction" :title="corner.title"><span v-for="facet in 4" :key="facet" class="cube-corner-facet" aria-hidden="true"></span></button>
</div></div></div>
</template>
