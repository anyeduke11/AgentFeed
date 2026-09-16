<template>
  <svg
    class="ic"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    :fill="filled ? 'currentColor' : 'none'"
    :stroke="filled ? 'none' : 'currentColor'"
    :stroke-width="filled ? 0 : 2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="(d, i) in paths" :key="i" :d="d" />
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { iconPaths, isFilled } from '../utils/icons'

const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 16 })
const paths = computed(() => iconPaths(props.name))
const filled = computed(() => isFilled(props.name))
</script>
