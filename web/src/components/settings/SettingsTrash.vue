<template>
  <!-- 回收区 -->
  <div class="sect">
    <div class="sect-head"><span class="sq"></span><h2 class="stitle">已删除文件（{{ deleted.length }}）</h2><div class="sright"><button class="btn xs danger" :disabled="!deleted.length" @click="ui.openModal('purge')"><Icon name="trash" :size="12" /> 清理全部</button></div></div>
    <template v-if="deleted.length">
      <div v-for="f in deleted" :key="f.id" class="delrow">
        <span class="dn mono">{{ f.path }}</span>
        <button class="btn xs" @click="restoreDeleted(f)"><Icon name="rotate" :size="12" /> 恢复</button>
        <button class="btn xs danger" @click="purgeOne(f)"><Icon name="trash" :size="12" /> 彻底删除</button>
      </div>
    </template>
    <template v-else>
      <div style="padding:4px 0 0"><div class="empty" style="padding:22px">
        <span class="e-ic"><Icon name="trash" :size="26" /></span>
        <div class="e-t">回收区为空</div>
        <div class="e-s">已删除的文件清理后不再占用索引空间。</div>
      </div></div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import { useUiStore } from '../../stores/useUiStore'
import { api } from '../../api'

const props = defineProps<{ refreshSeq?: number }>()

const ui = useUiStore()

const deleted = ref<any[]>([])

/** 拉取回收区列表（对应原页面 refresh 中 deleted 相关部分） */
async function loadDeleted() {
  try {
    const data = await api.files.list({ status: 'deleted', limit: '100' })
    deleted.value = data.items || []
  } catch {
    deleted.value = []
  }
}

async function restoreDeleted(f: any) {
  await api.files.batch([f.id], 'restore')
  ui.toast(`已恢复「${f.title || f.name}」`)
  await loadDeleted()
}

async function purgeOne(f: any) {
  await api.files.purgeOne(f.id)
  ui.toast('已彻底删除该文件及索引记录')
  await loadDeleted()
}

// 进入 tab 首次挂载拉取数据（KeepAlive 缓存后切回不重复拉取，与拆分前一致）
onMounted(loadDeleted)
// 父层「刷新」按钮：重新拉取本 tab 数据
watch(() => props.refreshSeq, loadDeleted)
</script>
