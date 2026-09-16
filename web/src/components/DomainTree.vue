<template>
  <div class="tree">
    <TreeNode v-for="node in tree" :key="node.id" :node="node" @update="$emit('update', $event)" @remove="$emit('remove', $event)" />
  </div>
</template>

<script setup lang="ts">
import TreeNode from './TreeNode.vue'
defineProps<{ tree: any[] }>()
defineEmits(['update', 'remove'])
</script>

<style scoped>
.tree { padding-left: 8px; }
</style>
