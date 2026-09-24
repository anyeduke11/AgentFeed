<template>
  <div class="node">
    <div class="row">
      <span class="name">{{ node.name }}</span>
      <input v-model="editName" v-if="editing" />
      <input v-model="editColor" v-if="editing" class="color" />
      <button v-if="!editing" @click="editing = true">编辑</button>
      <button v-else @click="save">保存</button>
      <button @click="$emit('remove', node.id)">删除</button>
    </div>
    <div v-if="node.children?.length" class="children">
      <DomainTree :tree="node.children" @update="$emit('update', $event)" @remove="$emit('remove', $event)" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import DomainTree from './DomainTree.vue'

const props = defineProps<{ node: any }>()
const emit = defineEmits(['update', 'remove'])
const editing = ref(false)
const editName = ref(props.node.name)
const editColor = ref(props.node.color)

function save() {
  emit('update', props.node.id, { name: editName.value, color: editColor.value })
  editing.value = false
}
</script>

<style scoped>
.node { margin: 6px 0; }
.row { display: flex; align-items: center; gap: 8px; }
.name { font-size: 13px; color: var(--ink); }
.color { width: 80px; }
.children { padding-left: 18px; }
</style>
