<template>
  <!-- 局域网与安全 -->
  <div class="sect">
    <div class="sect-head"><span class="sq"></span><h2 class="stitle">局域网与安全</h2><div class="sright"><span class="cap">仅本机 127.0.0.1</span></div></div>
    <div class="setrow">
      <span class="sr-k">局域网访问</span>
      <span class="sr-v"><span class="cap">预留功能：开启后支持局域网访问 + token 认证（暂未开放）</span></span>
      <span class="sr-a"><button class="switch" role="switch" aria-checked="false" disabled aria-disabled="true" title="预留功能，暂不可开启"></button></span>
    </div>
    <div class="sec-list">
      <div class="sec-line"><Icon name="shield" :size="15" /><span>MCP 与看板均仅监听 127.0.0.1，不暴露公网端口</span></div>
      <div class="sec-line"><Icon name="shield" :size="15" /><span>不存全文：只保留摘要与词条，原文始终留在本地扫描根</span></div>
      <div class="sec-line"><Icon name="shield" :size="15" /><span>打开与定位操作会校验路径必须位于已注册扫描根之下</span></div>
      <div class="sec-line"><Icon name="shield" :size="15" /><span>敏感信息过滤开启 · 软删除可恢复 · md5 版本链可追溯</span></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import Icon from '../Icon.vue'

// 纯静态展示 tab：声明 refreshSeq 仅为了避免父层透传属性落到根元素
defineProps<{ refreshSeq?: number }>()
</script>
