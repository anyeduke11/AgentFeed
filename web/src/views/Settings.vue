<template>
  <div class="content">
    <div class="view-head">
      <span class="plate">07</span>
      <h1 class="vtitle">调度室</h1>
      <span class="vsub">扫描根 · AI 队列 · 回收区 · 安全</span>
      <div class="vright">
        <button class="btn sm" @click="refresh"><Icon name="refresh" :size="13" /> 刷新</button>
      </div>
    </div>

    <div class="set-col">
      <!-- 功能区一行 Tab -->
      <div class="tabs">
        <button class="tab" :class="{ on: settingsTab === 'roots' }" @click="settingsTab = 'roots'">扫描根</button>
        <button class="tab" :class="{ on: settingsTab === 'ai' }" @click="settingsTab = 'ai'">AI 设置与队列</button>
        <button class="tab" :class="{ on: settingsTab === 'gate' }" @click="settingsTab = 'gate'">过滤门禁</button>
        <button class="tab" :class="{ on: settingsTab === 'records' }" @click="settingsTab = 'records'">过滤记录</button>
        <button class="tab" :class="{ on: settingsTab === 'deleted' }" @click="settingsTab = 'deleted'">已删除文件</button>
        <button class="tab" :class="{ on: settingsTab === 'security' }" @click="settingsTab = 'security'">局域网与安全</button>
        <button class="tab" :class="{ on: settingsTab === 'logs' }" @click="settingsTab = 'logs'">日志管理</button>
      </div>

      <!-- 扫描根 -->
      <div v-if="settingsTab === 'roots'" class="sect">
        <div class="sect-head"><span class="sq"></span><h2 class="stitle">扫描根（{{ settings.roots.length }} 个）</h2><div class="sright"><span class="cap mono">{{ settings.scanStatus.watcherRunning ? 'watcher 运行中' : 'watcher 未运行' }}</span></div></div>
        <div v-for="r in settings.roots" :key="r.id" class="rootrow">
          <span><span class="rp">{{ r.path }}</span> <span class="rc">{{ r.enabled ? (r.files != null ? r.files + ' 个文件' : '') : '停用' }}</span></span>
          <span class="rootstop">{{ r.enabled ? '启用' : '停用' }}</span>
          <span style="display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap">
            <button class="switch" role="switch" :aria-checked="r.enabled ? 'true' : 'false'" :aria-label="`启用或停用扫描根 ${r.path}`" @click="toggleRoot(r)"></button>
            <button class="btn xs" @click="rescan(r)"><Icon name="refresh" :size="12" /> 全量重扫</button>
            <button class="btn xs danger" @click="removeRoot(r)"><Icon name="trash" :size="12" /> 移除</button>
          </span>
        </div>
        <div class="addroot">
          <template v-if="addingRoot">
            <input class="inp" v-model="newRoot" placeholder="/absolute/path/to/dir" aria-label="新扫描根路径" @keyup.enter="confirmAddRoot" />
            <button class="btn sm primary" @click="confirmAddRoot">确认添加</button>
            <button class="btn sm" @click="addingRoot = false">取消</button>
          </template>
          <template v-else>
            <button class="btn sm" @click="addingRoot = true"><Icon name="plus" :size="14" /> 新增扫描根</button>
            <span class="supply-note">新增后会执行一次全量扫描；watcher 会持续监听启用的扫描根。</span>
          </template>
        </div>
        <!-- Agent 目录一键挂载 -->
        <div class="cap" style="display:block;margin:14px 14px 8px">Agent 目录（国内外常见智能体的本机数据目录 · 点击挂载，再次点击启停）</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;padding:0 14px 4px">
          <button v-for="a in agentRoots" :key="a.name" class="chip"
            :class="{ on: !!a.rootId && a.enabled }"
            :style="!a.exists ? 'opacity:.4' : ''"
            :disabled="!a.exists && !a.rootId"
            :title="a.path + (a.exists ? '' : '（本机未检测到）')"
            @click="toggleAgentRoot(a)">
            <span class="dot" :class="a.rootId ? (a.enabled ? 'dot-run' : 'dot-pause') : 'dot-pend'"></span>
            {{ a.name }}<span v-if="a.rootId" class="stb" style="margin-left:4px">{{ a.enabled ? '启用中' : '已停用' }}</span>
          </button>
        </div>
      </div>

      <!-- AI 设置与队列 -->
      <div v-if="settingsTab === 'ai'" class="sect">
        <div class="sect-head"><span class="sq"></span><h2 class="stitle">AI 设置与队列</h2><div class="sright"><span class="cap">OpenAI 兼容 · 本地优先</span></div></div>
        <div class="tabs" style="padding:10px 14px 0">
          <button class="tab" :class="{ on: aiTab === 'providers' }" @click="aiTab = 'providers'">服务商与队列</button>
          <button class="tab" :class="{ on: aiTab === 'ollama' }" @click="switchOllamaTab">Ollama 模型</button>
          <button class="tab" :class="{ on: aiTab === 'nodes' }" @click="switchNodesTab">蒸馏池</button>
        </div>
        <template v-if="aiTab === 'providers'">
        <div class="setrow">
          <span class="sr-k">默认服务商</span>
          <span class="sr-v"><span class="cap">蒸馏与打分请求发往该服务商</span></span>
          <span class="sr-a">
            <select class="inp" style="max-width:200px" :value="llm.providers.defaultProvider" aria-label="默认服务商" @change="changeProvider(($event.target as HTMLSelectElement).value)">
              <option v-for="p in llm.providers.providers || []" :key="p.name" :value="p.name">{{ providerLabel(p.name) }}</option>
            </select>
          </span>
        </div>
        <div class="setrow">
          <span class="sr-k">默认模型</span>
          <span class="sr-v"><span class="mono">{{ llm.providers.defaultModel || '—' }}</span></span>
          <span class="sr-a">
            <select class="inp" style="max-width:220px" :value="llm.providers.defaultModel" aria-label="默认模型" @change="changeModel(($event.target as HTMLSelectElement).value)">
              <option v-for="m in defaultProviderModels" :key="m" :value="m">{{ m }}</option>
            </select>
          </span>
        </div>
        <div class="setrow" v-for="p in cloudProviders" :key="p.name">
          <span class="sr-k">{{ providerLabel(p.name) }}</span>
          <span class="sr-v" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input class="inp" style="max-width:300px" v-model="p.baseUrl" :aria-label="p.name + ' baseUrl'" />
            <input class="inp" style="max-width:170px" v-model="p.apiKey" :type="p.showKey ? 'text' : 'password'" autocomplete="off" :placeholder="p.hasKey ? '已配置 · 输入可修改' : 'API Key'" :aria-label="p.name + ' API Key'" />
            <button class="btn xs" :aria-label="(p.showKey ? '隐藏' : '查看') + ' ' + p.name + ' API Key'" :title="p.showKey ? '隐藏' : '查看'" @click="p.showKey = !p.showKey"><Icon :name="p.showKey ? 'eyeOff' : 'eye'" :size="12" /></button>
          </span>
          <span class="sr-a" style="display:flex;gap:8px;align-items:center">
            <input class="inp" style="max-width:220px" v-model="p.modelsText" :placeholder="p.name === 'xfyun' ? 'ModelID（服务管控页获取），逗号分隔' : '模型，逗号分隔'" :aria-label="p.name + ' 模型列表（逗号分隔）'" />
            <button v-if="p.name !== 'xfyun'" class="btn xs" :disabled="refreshingModels === p.name" :title="refreshingModels === p.name ? '拉取中…' : '拉取该服务商在线模型列表并合并'" :aria-label="'刷新 ' + p.name + ' 模型列表'" @click="refreshModels(p)"><Icon name="refresh" :size="12" /></button>
            <span v-if="p.hasKey || p.apiKey" class="vbadge ok">已配 Key</span>
            <span v-else class="vbadge off">未配置</span>
            <span class="stepper" :title="'该服务商并发限额（按接口限流宽松度调整）'">
              <button :disabled="providerConc(p.name) <= 1" :aria-label="'降低 ' + p.name + ' 并发'" @click="setProviderConc(p.name, providerConc(p.name) - 1)"><Icon name="minus" :size="12" /></button>
              <span class="val">{{ providerConc(p.name) }}</span>
              <button :disabled="providerConc(p.name) >= concMax" :aria-label="'提高 ' + p.name + ' 并发'" @click="setProviderConc(p.name, providerConc(p.name) + 1)"><Icon name="plus" :size="12" /></button>
            </span>
            <button class="btn xs" @click="saveProvider(p)">保存</button>
          </span>
        </div>
        <div class="setrow">
          <span class="sr-k">自动标注</span>
          <span class="sr-v"><span class="cap">入库后自动补齐标签与领域（{{ autotag ? '已开启' : '已关闭' }}）</span></span>
          <span class="sr-a"><button class="switch" role="switch" :aria-checked="autotag ? 'true' : 'false'" aria-label="自动标注开关" @click="toggleAutotag"></button></span>
        </div>
        <div class="setrow">
          <span class="sr-k">队列并发</span>
          <span class="sr-v"><span class="cap">每服务商同时精炼的文件数（1 至 {{ concMax }}，默认按接口限流推荐 {{ concRec }}；各服务商可单独调整）</span></span>
          <span class="sr-a">
            <span class="stepper">
              <button :disabled="conc <= 1" aria-label="降低并发" @click="setConc(conc - 1)"><Icon name="minus" :size="13" /></button>
              <span class="val">{{ conc }}</span>
              <button :disabled="conc >= concMax" aria-label="提高并发" @click="setConc(conc + 1)"><Icon name="plus" :size="13" /></button>
            </span>
          </span>
        </div>
        <div class="setrow">
          <span class="sr-k">队列状态</span>
          <span class="sr-v">
            <span class="qchip" :class="{ paused: paused }"><span class="dot" :class="paused ? 'dot-pause' : 'dot-run'"></span>{{ paused ? '已暂停' : '运行中' }}</span>
          </span>
          <span class="sr-a"><button class="btn xs" @click="togglePause"><Icon :name="paused ? 'play' : 'pause'" :size="12" /> {{ paused ? '恢复' : '暂停' }}</button></span>
        </div>
        </template>
          <template v-else-if="aiTab === 'ollama'">
          <div class="setrow">
            <span class="sr-k">连接状态</span>
            <span class="sr-v">
              <span v-if="ollamaProbing" class="cap">探测中…</span>
              <span v-else-if="ollamaOnline" class="qchip"><span class="dot dot-run"></span>在线 · {{ ollamaModels.length }} 个已装模型</span>
              <span v-else class="qchip paused"><span class="dot dot-pause"></span>离线 · 检查 Ollama 服务（默认 127.0.0.1:11434）</span>
            </span>
            <span class="sr-a"><button class="btn xs" :disabled="ollamaProbing" @click="probeOllama"><Icon name="refresh" :size="12" /> 重新检测</button></span>
          </div>
          <div class="setrow">
            <span class="sr-k">服务地址</span>
            <span class="sr-v"><span class="cap">Ollama 本地服务地址（默认 127.0.0.1:11434）· 本地服务无需密钥</span></span>
            <span class="sr-a" style="display:flex;gap:8px;align-items:center">
              <input class="inp" style="max-width:260px" v-model="ollamaDraft.baseUrl" aria-label="ollama baseUrl" />
              <button class="btn xs" @click="saveOllamaBaseUrl">保存</button>
            </span>
          </div>
          <template v-if="ollamaOnline">
            <div class="cap" style="display:block;margin:10px 14px 2px">已装模型：勾选启用（可多选同时调用）；点击类型徽标切换 对话 / 向量。</div>
            <div class="setrow" v-for="m in ollamaModels" :key="m.id">
              <span class="sr-k mono" style="font-size:12.5px">{{ m.id }}</span>
              <span class="sr-v"><span class="cap">{{ m.enabled ? '已启用' : '未启用' }}</span></span>
              <span class="sr-a" style="display:flex;gap:10px;align-items:center">
                <button class="btn xs" :title="'切换为' + (m.type === 'embedding' ? '对话' : '向量') + '模型'" @click="toggleModelType(m)">{{ m.type === 'embedding' ? '向量' : '对话' }}</button>
                <button class="switch" role="checkbox" :aria-checked="m.enabled ? 'true' : 'false'" :aria-label="'启用模型 ' + m.id" @click="toggleModelEnabled(m)"></button>
              </span>
            </div>
            <div class="setrow">
              <span class="sr-k">蒸馏向量化</span>
              <span class="sr-v"><span class="cap">蒸馏完成后自动用向量模型生成语义向量（支持语义检索）</span></span>
              <span class="sr-a" style="display:flex;gap:10px;align-items:center">
                <select class="inp" style="max-width:200px" v-model="embeddingModel" :style="embeddingEnabled ? '' : 'opacity:.35'" :disabled="!embeddingEnabled" aria-label="向量模型">
                  <option value="">选择向量模型</option>
                  <option v-for="m in embeddingCandidates" :key="m" :value="m">{{ m }}</option>
                </select>
                <button class="switch" role="switch" :aria-checked="embeddingEnabled ? 'true' : 'false'" aria-label="蒸馏向量化开关" @click="embeddingEnabled = !embeddingEnabled"></button>
              </span>
            </div>
            <div class="addroot">
              <button class="btn sm primary" @click="saveOllamaConfig"><Icon name="check" :size="14" /> 保存 Ollama 配置</button>
              <span class="supply-note">启用的模型会注册到本地服务商，可与云端模型并行使用；向量模型用于蒸馏后的语义向量化。</span>
            </div>
          </template>
          <div class="setrow">
            <span class="sr-k">向量库</span>
            <span class="sr-v"><span class="cap">已向量化 {{ embedStatus.embedded }} 篇{{ embedStatus.remaining ? ` · 待补 ${embedStatus.remaining} 篇` : ' · 无待补' }}<template v-if="(embedStatus.queueActive || 0) + (embedStatus.queuePending || 0) > 0"> · 向量队列处理中 {{ (embedStatus.queueActive || 0) + (embedStatus.queuePending || 0) }} 篇</template></span></span>
            <span class="sr-a"><button class="btn xs" :disabled="!embedReady" :title="embedReady ? '' : '先开启蒸馏向量化并选择向量模型'" @click="triggerEmbedBackfill"><Icon name="rotate" :size="12" /> 补向量（≤200 篇）</button></span>
          </div>
          <div class="setrow">
            <span class="sr-k">语义检索</span>
            <span class="sr-v" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <input class="inp" style="max-width:300px" v-model="searchQuery" placeholder="输入查询验证语义检索" aria-label="语义检索查询" @keyup.enter="doEmbedSearch" />
              <button class="btn xs" :disabled="!embedReady || !searchQuery.trim()" @click="doEmbedSearch"><Icon name="search" :size="12" /> 检索</button>
            </span>
            <span class="sr-a"></span>
          </div>
          <template v-if="searchHits.length">
            <div v-for="h in searchHits" :key="h.file_id" class="delrow">
              <span class="dn"><span>{{ h.title }}</span> <span class="stb">相似度 {{ h.score.toFixed(3) }}</span></span>
            </div>
          </template>
          <div v-else-if="searched" class="cap" style="display:block;padding:0 14px 8px">无检索结果（向量库为空或未向量化）。</div>
        </template>
          <template v-else-if="aiTab === 'nodes'">
            <!-- 蒸馏节点池：配置≠启用，启用后按 weight 份额分流到存活节点；全关时走默认模型 -->
            <div class="cap" style="display:block;padding:10px 14px 2px">配置好模型不等于启用：启用节点后，蒸馏任务按「并发份额」自动分流到存活节点（running/weight 最小者优先，失败自动轮换其他健康节点，最多 3 跳）；全部停用则回到默认模型单路蒸馏。</div>
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin:10px 14px 6px;flex-wrap:wrap">
              <span class="cap">已启用 {{ enabledNodeCount }}/{{ nodes.length }} 个节点<template v-if="enabledNodeCount"> · 当前并行 {{ nodeRunningSum }} 个任务</template></span>
              <button class="btn xs" :disabled="checkingAll || !enabledNodeCount" @click="checkAllNodes"><Icon name="refresh" :size="12" /> {{ checkingAll ? '检测中…' : '检测存活' }}</button>
            </div>
            <template v-for="g in groupedNodes" :key="g.provider">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin:14px 14px 4px;flex-wrap:wrap">
                <span class="cap" style="font-weight:600">{{ g.label }}（{{ g.nodes.length }} 个模型 · {{ g.nodes.filter((x: any) => x.enabled).length }} 启用）</span>
                <span style="display:flex;gap:8px;align-items:center">
                  <template v-if="addingProvider === g.provider">
                    <input class="inp" style="max-width:220px" v-model="addModelName" placeholder="输入模型名，如 gpt-4o-mini" :aria-label="'为 ' + g.label + ' 添加模型'" @keyup.enter="confirmAddModel(g.provider)" />
                    <button class="btn xs primary" :disabled="!addModelName.trim()" @click="confirmAddModel(g.provider)">添加</button>
                    <button class="btn xs" @click="cancelAddModel">取消</button>
                  </template>
                  <button v-else class="btn xs" @click="startAddModel(g.provider)"><Icon name="plus" :size="12" /> 添加模型</button>
                </span>
              </div>
            <div class="setrow" v-for="n in g.nodes" :key="n.provider + '|' + n.model">
              <span class="sr-k mono" style="font-size:12.5px">
                <template v-if="renamingKey === n.provider + '|' + n.model">
                  <input class="inp" style="max-width:200px" v-model="renameValue" :aria-label="'重命名模型 ' + n.model" @keyup.enter="confirmRename(n)" />
                </template>
                <template v-else>{{ providerLabel(n.provider) }} · {{ n.model }}</template>
              </span>
              <span class="sr-v" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <span :class="'vbadge ' + nodeBadge(n).cls" :title="nodeBadge(n).title">{{ nodeBadge(n).text }}</span>
                <span v-if="n.enabled" class="cap">运行 {{ n.running || 0 }} · 份额 {{ n.weight }}</span>
              </span>
              <span class="sr-a" style="display:flex;gap:10px;align-items:center">
                <span v-if="n.enabled" class="stepper" title="并发份额：数值越大分到越多蒸馏任务（1-16）">
                  <button :disabled="n.weight <= 1" :aria-label="'降低 ' + n.model + ' 份额'" @click="setNodeWeight(n, n.weight - 1)"><Icon name="minus" :size="12" /></button>
                  <span class="val">{{ n.weight }}</span>
                  <button :disabled="n.weight >= 16" :aria-label="'提高 ' + n.model + ' 份额'" @click="setNodeWeight(n, n.weight + 1)"><Icon name="plus" :size="12" /></button>
                </span>
                <template v-if="renamingKey === n.provider + '|' + n.model">
                  <button class="btn xs primary" :disabled="!renameValue.trim()" @click="confirmRename(n)">保存</button>
                  <button class="btn xs" @click="renamingKey = ''">取消</button>
                </template>
                <template v-else>
                  <button class="btn xs" :disabled="checkingNode === n.provider + n.model" @click="checkNodeOne(n)"><Icon name="refresh" :size="12" /> 检测</button>
                  <button class="btn xs" title="重命名模型" @click="startRename(n)">改名</button>
                  <button class="btn xs" :class="{ danger: confirmDelKey === n.provider + '|' + n.model }" @click="removeNode(n)">{{ confirmDelKey === n.provider + '|' + n.model ? '确认删除' : '删除' }}</button>
                </template>
                <button class="switch" role="switch" :aria-checked="n.enabled ? 'true' : 'false'" :aria-label="'启用节点 ' + n.provider + ' ' + n.model" @click="toggleNode(n)"></button>
              </span>
            </div>
            </template>
          </template>
      </div>

      <!-- 过滤门禁 -->
      <div v-if="settingsTab === 'gate'" class="sect">
        <div class="sect-head"><span class="sq"></span><h2 class="stitle">过滤门禁</h2><div class="sright"><span class="cap">入库前过滤 · 拦截可恢复</span></div></div>
        <div class="setrow">
          <span class="sr-k">门禁开关</span>
          <span class="sr-v"><span class="cap">关闭后大小与内容门禁不再拦截（各规则可单独开关）</span><span v-if="masterBadge" :class="'vbadge ' + masterBadge.cls" :title="masterBadge.title">{{ masterBadge.text }}</span></span>
          <span class="sr-a"><button class="switch" role="switch" :aria-checked="gate.enabled ? 'true' : 'false'" aria-label="过滤门禁开关" @click="toggleGate"></button></span>
        </div>
        <div class="setrow">
          <span class="sr-k">最小文件大小</span>
          <span class="sr-v"><span class="cap">低于该字节数的文件不纳入（占位符、单行说明）</span><span v-if="vmap.minSize" :class="'vbadge ' + vmap.minSize.cls" :title="vmap.minSize.title">{{ vmap.minSize.text }}</span></span>
          <span class="sr-a" style="display:flex;gap:10px;align-items:center;flex-wrap:nowrap">
            <input class="inp" style="max-width:120px" :style="gate.minSizeEnabled ? '' : 'opacity:.35'" :disabled="!gate.minSizeEnabled" v-model.number="gate.minSize" type="number" min="0" aria-label="最小文件大小" />
            <button class="switch" role="switch" :aria-checked="gate.minSizeEnabled ? 'true' : 'false'" aria-label="最小文件大小门禁开关" @click="toggleRule('minSizeEnabled')"></button>
          </span>
        </div>
        <div class="setrow">
          <span class="sr-k">最小正文字符</span>
          <span class="sr-v"><span class="cap">去 frontmatter / 代码围栏 / md 符号后的有效字符数</span><span v-if="vmap.minChars" :class="'vbadge ' + vmap.minChars.cls" :title="vmap.minChars.title">{{ vmap.minChars.text }}</span></span>
          <span class="sr-a" style="display:flex;gap:10px;align-items:center;flex-wrap:nowrap">
            <input class="inp" style="max-width:120px" :style="gate.minCharsEnabled ? '' : 'opacity:.35'" :disabled="!gate.minCharsEnabled" v-model.number="gate.minChars" type="number" min="0" aria-label="最小正文字符" />
            <button class="switch" role="switch" :aria-checked="gate.minCharsEnabled ? 'true' : 'false'" aria-label="最小正文字符门禁开关" @click="toggleRule('minCharsEnabled')"></button>
          </span>
        </div>
        <div class="setrow">
          <span class="sr-k">代码占比上限</span>
          <span class="sr-v"><span class="cap">代码围栏行占比超过该值视为代码清单（0-1）</span><span v-if="vmap.codeRatio" :class="'vbadge ' + vmap.codeRatio.cls" :title="vmap.codeRatio.title">{{ vmap.codeRatio.text }}</span></span>
          <span class="sr-a" style="display:flex;gap:10px;align-items:center;flex-wrap:nowrap">
            <input class="inp" style="max-width:120px" :style="gate.codeRatioEnabled ? '' : 'opacity:.35'" :disabled="!gate.codeRatioEnabled" v-model.number="gate.codeRatio" type="number" min="0" max="1" step="0.1" aria-label="代码占比上限" />
            <button class="switch" role="switch" :aria-checked="gate.codeRatioEnabled ? 'true' : 'false'" aria-label="代码占比门禁开关" @click="toggleRule('codeRatioEnabled')"></button>
          </span>
        </div>
        <div class="setrow">
          <span class="sr-k">排除目录</span>
          <span class="sr-v"><span class="cap">逗号分隔；命中即彻底忽略，不入库不记录</span><span v-if="vmap.excludeDirs" :class="'vbadge ' + vmap.excludeDirs.cls" :title="vmap.excludeDirs.title">{{ vmap.excludeDirs.text }}</span></span>
          <span class="sr-a" style="display:flex;gap:10px;align-items:center;flex-wrap:nowrap">
            <input class="inp" style="max-width:340px" :style="gate.excludeDirsEnabled ? '' : 'opacity:.35'" :disabled="!gate.excludeDirsEnabled" v-model="gate.excludeDirsText" aria-label="排除目录" />
            <button class="switch" role="switch" :aria-checked="gate.excludeDirsEnabled ? 'true' : 'false'" aria-label="排除目录门禁开关" @click="toggleRule('excludeDirsEnabled')"></button>
          </span>
        </div>
        <div class="setrow">
          <span class="sr-k">文件名白名单</span>
          <span class="sr-v"><span class="cap">精确文件名命中即放行（AGENTS.md、CLAUDE.md 等）</span><span v-if="vmap.filenameWhitelist" :class="'vbadge ' + vmap.filenameWhitelist.cls" :title="vmap.filenameWhitelist.title">{{ vmap.filenameWhitelist.text }}</span></span>
          <span class="sr-a" style="display:flex;gap:10px;align-items:center;flex-wrap:nowrap">
            <input class="inp" style="max-width:340px" :style="gate.filenameWhitelistEnabled ? '' : 'opacity:.35'" :disabled="!gate.filenameWhitelistEnabled" v-model="gate.whitelistText" aria-label="文件名白名单" />
            <button class="switch" role="switch" :aria-checked="gate.filenameWhitelistEnabled ? 'true' : 'false'" aria-label="文件名白名单开关" @click="toggleRule('filenameWhitelistEnabled')"></button>
          </span>
        </div>
        <div class="setrow">
          <span class="sr-k">关键词白名单</span>
          <span class="sr-v"><span class="cap">文件名包含任一关键词即放行（PRD、测试记录等）</span><span v-if="vmap.keywords" :class="'vbadge ' + vmap.keywords.cls" :title="vmap.keywords.title">{{ vmap.keywords.text }}</span></span>
          <span class="sr-a" style="display:flex;gap:10px;align-items:center;flex-wrap:nowrap">
            <input class="inp" style="max-width:340px" :style="gate.keywordsEnabled ? '' : 'opacity:.35'" :disabled="!gate.keywordsEnabled" v-model="gate.keywordsText" aria-label="关键词白名单" />
            <button class="switch" role="switch" :aria-checked="gate.keywordsEnabled ? 'true' : 'false'" aria-label="关键词白名单开关" @click="toggleRule('keywordsEnabled')"></button>
          </span>
        </div>
        <div class="setrow">
          <span class="sr-k">文件黑名单</span>
          <span class="sr-v"><span class="cap">逗号分隔；*.tmp.md 通配、.log 扩展名、/正则/、纯文本（文件名包含）命中即拦截（优先级高于白名单放行，低于路径白名单）</span><span v-if="vmap.blacklist" :class="'vbadge ' + vmap.blacklist.cls" :title="vmap.blacklist.title">{{ vmap.blacklist.text }}</span></span>
          <span class="sr-a" style="display:flex;gap:10px;align-items:center;flex-wrap:nowrap">
            <input class="inp" style="max-width:340px" :style="gate.blacklistEnabled ? '' : 'opacity:.35'" :disabled="!gate.blacklistEnabled" v-model="gate.blacklistText" aria-label="文件黑名单" />
            <button class="switch" role="switch" :aria-checked="gate.blacklistEnabled ? 'true' : 'false'" aria-label="文件黑名单开关" @click="toggleRule('blacklistEnabled')"></button>
          </span>
        </div>
        <div class="setrow">
          <span class="sr-k">路径白名单</span>
          <span class="sr-v"><span class="cap">绝对路径前缀匹配；命中无视大小与内容门禁强制入库蒸馏（优先级高于排除目录）</span><span v-if="vmap.pathWhitelist" :class="'vbadge ' + vmap.pathWhitelist.cls" :title="vmap.pathWhitelist.title">{{ vmap.pathWhitelist.text }}</span></span>
          <span class="sr-a" style="display:flex;gap:10px;align-items:center;flex-wrap:nowrap">
            <input class="inp" style="max-width:340px" :style="gate.pathWhitelistEnabled ? '' : 'opacity:.35'" :disabled="!gate.pathWhitelistEnabled" v-model="gate.pathWhitelistText" aria-label="路径白名单" />
            <button class="switch" role="switch" :aria-checked="gate.pathWhitelistEnabled ? 'true' : 'false'" aria-label="路径白名单开关" @click="toggleRule('pathWhitelistEnabled')"></button>
          </span>
        </div>
        <div class="addroot">
          <button class="btn sm primary" @click="saveGate()"><Icon name="check" :size="14" /> 保存门禁配置</button>
          <span class="supply-note">保存后对新扫描生效；对已入库文件执行「全量重扫」可按新规则清洗。</span>
        </div>
      </div>

      <!-- 过滤记录 -->
      <div v-if="settingsTab === 'records'" class="sect">
        <div class="sect-head"><span class="sq"></span><h2 class="stitle">过滤记录</h2><div class="sright" style="display:flex;gap:8px;align-items:center">
          <span class="cap">误杀文件可手动恢复{{ gateView === 'skipped' && gateTotal > gateRecords.length ? ' · 仅显示最近 ' + gateRecords.length + ' 条' : '' }}</span>
          <button class="btn xs" :disabled="!gateTotal" @click="archiveAll"><Icon name="folder" :size="12" /> 全部存档</button>
        </div></div>
        <div class="tabs" style="padding:10px 14px 0">
          <button class="tab" :class="{ on: gateView === 'skipped' }" @click="gateView = 'skipped'">拦截中（{{ gateTotal }}）</button>
          <button class="tab" :class="{ on: gateView === 'restored' }" @click="gateView = 'restored'">已豁免（{{ exemptTotal }}）</button>
        </div>
        <template v-if="gateView === 'skipped'">
          <template v-if="gateRecords.length">
            <div v-for="r in gateRecords" :key="r.id" class="delrow">
              <span class="dn"><span class="mono">{{ r.path }}</span> <span class="stb">{{ r.gate_reason }}</span></span>
              <button class="btn xs" @click="restoreGate(r)"><Icon name="rotate" :size="12" /> 恢复</button>
              <button class="btn xs danger" @click="removeGateRecord(r)"><Icon name="trash" :size="12" /> 删除记录</button>
            </div>
          </template>
          <template v-else>
            <div style="padding:4px 0 0"><div class="empty" style="padding:22px">
              <span class="e-ic"><Icon name="shield" :size="26" /></span>
              <div class="e-t">暂无过滤记录</div>
              <div class="e-s">被门禁拦截的文件会出现在这里，误杀可手动恢复入库。</div>
            </div></div>
          </template>
        </template>
        <template v-else>
          <template v-if="exemptRecords.length">
            <div v-for="r in exemptRecords" :key="r.id" class="delrow">
              <span class="dn"><span class="mono">{{ r.path }}</span> <span class="stb">当初拦截原因：{{ r.gate_reason || '未知' }}</span></span>
              <button class="btn xs danger" @click="unexemptRecord(r)"><Icon name="x" :size="12" /> 取消豁免</button>
            </div>
            <div class="cap" style="display:block;padding:8px 14px">取消豁免后，下次「全量重扫」将按当前门禁规则重新评估该文件。</div>
          </template>
          <template v-else>
            <div style="padding:4px 0 0"><div class="empty" style="padding:22px">
              <span class="e-ic"><Icon name="shield" :size="26" /></span>
              <div class="e-t">暂无豁免记录</div>
              <div class="e-s">手动恢复过的文件会出现在这里，可取消豁免让其重新接受门禁评估。</div>
            </div></div>
          </template>
        </template>
        <template v-if="archives.length">
          <div class="cap" style="display:block;margin:14px 0 6px;padding:0 14px">历史存档（按月 CSV · 归档后从上方列表移除）</div>
          <div style="display:flex;gap:8px;padding:0 14px;margin-bottom:8px;flex-wrap:wrap">
            <input class="inp" style="max-width:280px" v-model="archiveQuery" placeholder="搜索已归档记录（路径 / 原因）" aria-label="搜索存档" @keyup.enter="doSearchArchives" />
            <select class="inp" style="max-width:130px" v-model="archiveMonth" aria-label="存档月份">
              <option value="">全部月份</option>
              <option v-for="a in archives" :key="a.file" :value="a.month">{{ a.month }}</option>
            </select>
            <button class="btn xs" @click="doSearchArchives"><Icon name="search" :size="12" /> 搜索</button>
          </div>
          <template v-if="archiveResults.length">
            <div v-for="(r, i) in archiveResults" :key="i" class="delrow">
              <span class="dn"><span class="mono">{{ r.path }}</span> <span class="stb">{{ r.gate_reason }} · {{ r.month }}</span></span>
              <button class="btn xs" @click="openCsv(`/api/gate/archives/${r.month}.csv`)"><Icon name="external" :size="12" /> CSV</button>
            </div>
            <div class="cap" style="display:block;padding:6px 14px">最多显示 100 条结果。</div>
          </template>
          <div v-else-if="archiveSearched" class="cap" style="display:block;padding:0 14px 6px">无匹配的归档记录。</div>
          <div v-for="a in archives" :key="a.file" class="delrow">
            <span class="dn"><span class="mono">{{ a.month }}</span> <span class="stb">{{ a.count }} 条 · {{ fmtSize(a.size) }}</span></span>
            <button class="btn xs" @click="openCsv(a.url)"><Icon name="external" :size="12" /> 查看 CSV</button>
          </div>
        </template>
      </div>

      <!-- 回收区 -->
      <div v-if="settingsTab === 'deleted'" class="sect">
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

      <!-- 局域网与安全 -->
      <div v-if="settingsTab === 'security'" class="sect">
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

      <!-- 日志管理 -->
      <div v-if="settingsTab === 'logs'" class="sect">
        <div class="sect-head"><span class="sq"></span><h2 class="stitle">日志管理</h2><div class="sright" style="display:flex;gap:8px;align-items:center">
          <input class="inp" style="max-width:240px" v-model="logKw" placeholder="搜索：模型 / 状态 / 错误 / 工具…" aria-label="搜索日志" @keyup.enter="loadLogs(true)" />
          <select v-if="logView === 'llm'" class="inp" style="max-width:110px" v-model="logStatus" aria-label="状态过滤" @change="loadLogs(true)">
            <option value="">全部状态</option>
            <option value="success">成功</option>
            <option value="failed">失败</option>
            <option value="timeout">超时</option>
            <option value="rate_limited">限流</option>
          </select>
          <button class="btn xs" @click="loadLogs(true)"><Icon name="search" :size="12" /> 搜索</button>
      </div></div>
        <div class="tabs" style="padding:10px 14px 0">
          <button class="tab" :class="{ on: logView === 'llm' }" @click="switchLogView('llm')">LLM 调用（{{ llmLogsTotal }}）</button>
          <button class="tab" :class="{ on: logView === 'mcp' }" @click="switchLogView('mcp')">MCP 调用（{{ mcpLogsTotal }}）</button>
          <button class="tab" :class="{ on: logView === 'service' }" @click="switchLogView('service')">服务日志（{{ svcLogs.length }}）</button>
        </div>
        <!-- LLM 调用日志（细化排错：文件名 / tokens 细分 / 点击展开完整错误与耗时明细） -->
        <template v-if="logView === 'llm'">
          <template v-if="llmLogs.length">
            <template v-for="l in llmLogs" :key="l.id">
              <div class="delrow" style="cursor:pointer" @click="expandedLog = expandedLog === l.id ? 0 : l.id">
                <span class="dn" style="display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center">
                  <span class="mono" style="font-size:11.5px">{{ l.created_at }}</span>
                  <span class="stb">{{ providerLabel(l.provider) }} · {{ l.model }}</span>
                  <span :class="'stb ' + (l.status === 'success' ? '' : 'bad')" :style="l.status === 'success' ? '' : 'color:#B3402A'">{{ statusLabel(l.status) }}</span>
                  <span style="font-size:12px;color:var(--text-1);font-weight:600;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" :title="l.file_name || ''">{{ l.file_name || `#${l.file_id ?? '-'}` }}</span>
                  <span class="cap mono">#{{ l.file_id ?? '-' }} · {{ fmtLogDur(l.duration_ms) }}</span>
                  <span v-if="l.error" class="cap mono" style="color:#B3402A;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ l.error }}</span>
                </span>
                <Icon :name="expandedLog === l.id ? 'chevronDown' : 'chevronDown'" :size="13" style="transform:rotate(-90deg);flex-shrink:0" :style="expandedLog === l.id ? 'transform:rotate(0deg)' : ''" />
              </div>
              <!-- 展开明细：完整错误 + token 细分 + 耗时 -->
              <div v-if="expandedLog === l.id" class="delrow" style="display:block;background:var(--bg-2, #F7F6F2);border-bottom:1px solid var(--border)">
                <div style="display:flex;flex-wrap:wrap;gap:8px 18px;padding:2px 0 8px;font-size:12px">
                  <span class="cap mono">文件 #{{ l.file_id ?? '-' }}{{ l.file_name ? ' · ' + l.file_name : '' }}</span>
                  <span class="cap mono">提示 {{ l.prompt_tokens ?? '-' }} tok</span>
                  <span class="cap mono">补全 {{ l.completion_tokens ?? '-' }} tok</span>
                  <span class="cap mono">合计 {{ l.total_tokens ?? '-' }} tok</span>
                  <span class="cap mono">耗时 {{ l.duration_ms != null ? fmtLogDur(l.duration_ms) + ` (${l.duration_ms}ms)` : '-' }}</span>
                  <span class="cap mono">调用 ID #{{ l.id }}</span>
                </div>
                <div v-if="l.error" style="padding:6px 10px;margin-bottom:8px;border:1px solid #E6CBC5;background:#FBF1EF;border-radius:3px">
                  <div class="cap" style="color:#B3402A;font-weight:600;margin-bottom:4px">错误详情</div>
                  <pre class="mono" style="margin:0;white-space:pre-wrap;word-break:break-all;font-size:11.5px;color:#8C3220;max-height:200px;overflow:auto">{{ l.error }}</pre>
                </div>
                <div v-else class="cap" style="padding-bottom:8px">本次调用成功，无错误信息。</div>
              </div>
            </template>
            <div v-if="llmLogs.length < llmLogsTotal" class="cap" style="display:block;padding:8px 14px;text-align:center">
              <button class="btn xs" @click="loadMoreLogs">加载更多（已显示 {{ llmLogs.length }} / {{ llmLogsTotal }}）</button>
            </div>
          </template>
          <template v-else>
            <div style="padding:4px 0 0"><div class="empty" style="padding:22px">
              <span class="e-ic"><Icon name="search" :size="26" /></span>
              <div class="e-t">暂无 LLM 调用日志</div>
              <div class="e-s">蒸馏与标注的每次模型调用（token 用量 / 耗时 / 状态）都会记录在这里。</div>
            </div></div>
          </template>
        </template>
        <!-- MCP 调用日志 -->
        <template v-else-if="logView === 'mcp'">
          <template v-if="mcpLogs.length">
            <div v-for="m in mcpLogs" :key="m.id" class="delrow">
              <span class="dn" style="display:flex;gap:10px;align-items:center">
                <span class="mono" style="font-size:11.5px">{{ m.created_at }}</span>
                <span class="stb mono">{{ m.tool }}</span>
                <span class="cap">客户端 {{ m.client }}</span>
              </span>
            </div>
            <div class="cap" style="display:block;padding:8px 14px">仅显示最近 {{ mcpLogs.length }} 条{{ mcpLogs.length < mcpLogsTotal ? '（共 ' + mcpLogsTotal + ' 条）' : '' }}。</div>
          </template>
          <template v-else>
            <div style="padding:4px 0 0"><div class="empty" style="padding:22px">
              <span class="e-ic"><Icon name="search" :size="26" /></span>
              <div class="e-t">暂无 MCP 调用日志</div>
              <div class="e-s">外部客户端通过 MCP 调用工具时会在这里留痕。</div>
            </div></div>
          </template>
        </template>
        <!-- 服务运行日志 -->
        <template v-else>
          <template v-if="svcLogs.length">
            <div style="padding:10px 14px 14px">
              <div v-for="(l, i) in svcLogs" :key="i" class="mono" :style="isErrLine(l) ? 'font-size:11.5px;line-height:1.7;color:#B3402A;word-break:break-all' : 'font-size:11.5px;line-height:1.7;color:#555;word-break:break-all'">{{ l }}</div>
            </div>
          </template>
          <template v-else>
            <div style="padding:4px 0 0"><div class="empty" style="padding:22px">
              <span class="e-ic"><Icon name="search" :size="26" /></span>
              <div class="e-t">暂无服务日志</div>
              <div class="e-s">服务启动、扫描、队列与回填等运行日志（.service.log 尾部）会显示在这里。</div>
            </div></div>
          </template>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import Icon from '../components/Icon.vue'
import { useSettingsStore } from '../stores/useSettingsStore'
import { useLlmStore } from '../stores/useLlmStore'
import { useUiStore } from '../stores/useUiStore'
import { api } from '../api'

const settings = useSettingsStore()
const llm = useLlmStore()
const ui = useUiStore()

const addingRoot = ref(false)
const newRoot = ref('')
const deleted = ref<any[]>([])
const agentRoots = ref<any[]>([])
const autotag = ref(true)
const gateRecords = ref<any[]>([])
const gateTotal = ref(0)
const exemptRecords = ref<any[]>([])
const exemptTotal = ref(0)
const gateView = ref<'skipped' | 'restored'>('skipped')
const settingsTab = ref<'roots' | 'ai' | 'gate' | 'records' | 'deleted' | 'security' | 'logs'>('roots')
const archives = ref<any[]>([])
const archiveQuery = ref('')
const archiveMonth = ref('')
const archiveResults = ref<any[]>([])
const archiveSearched = ref(false)
const gate = ref({
  enabled: true,
  minSize: 512,
  minChars: 300,
  codeRatio: 0.6,
  minSizeEnabled: true,
  minCharsEnabled: true,
  codeRatioEnabled: true,
  excludeDirsEnabled: true,
  filenameWhitelistEnabled: true,
  keywordsEnabled: true,
  excludeDirsText: '',
  whitelistText: '',
  keywordsText: '',
  blacklistText: '',
  blacklistEnabled: true,
  pathWhitelistText: '',
  pathWhitelistEnabled: true
})

/** 门禁配置有效性（后端按真实匹配语义逐字段校验，抓静默失败） */
const gateValidity = ref<{ masterEnabled: boolean; fields: any[] } | null>(null)

async function loadGateValidity() {
  try {
    gateValidity.value = await api.gate.validate()
  } catch {
    gateValidity.value = null
  }
}

/** field → 行内徽标 {cls, text, title}；无效 > 关闭 > 存疑 > 未配置 > 生效 */
const vmap = computed<Record<string, { cls: string; text: string; title: string }>>(() => {
  const m: Record<string, { cls: string; text: string; title: string }> = {}
  for (const f of gateValidity.value?.fields || []) {
    const detail = [...(f.issues || []), ...(f.warnings || [])].map((i: any) => `${i.entry}：${i.reason}`).join('\n')
    if (!f.enabled) m[f.field] = { cls: 'off', text: '已关闭', title: detail }
    else if ((f.issues || []).length) m[f.field] = { cls: 'bad', text: `${f.issues.length} 条无效`, title: detail }
    else if ((f.warnings || []).length) m[f.field] = { cls: 'bad', text: '存疑', title: detail }
    else if (!f.total) m[f.field] = { cls: 'off', text: '未配置', title: '' }
    else m[f.field] = { cls: 'ok', text: f.total > 1 ? `生效 · ${f.total} 条` : '生效', title: '' }
  }
  return m
})

const masterBadge = computed(() => {
  if (!gateValidity.value) return null
  return gateValidity.value.masterEnabled
    ? { cls: 'ok', text: '已开启', title: '' }
    : { cls: 'off', text: '已关闭 · 以下规则均不拦截', title: '' }
})

/** 服务商显示名（预设目录之外的条目回退原名） */
const PRESET_LABELS: Record<string, string> = {
  sensenova: '商汤 SenseNova',
  agnes: 'Agnes',
  deepseek: 'DeepSeek',
  zhipu: '智谱 GLM',
  moonshot: '月之暗面 Kimi',
  qwen: '通义千问 Qwen',
  xfyun: '讯飞星火',
  ollama: 'Ollama 本地',
}
function providerLabel(name: string) {
  return PRESET_LABELS[name] || name
}

/** 表单草稿：进入页面/保存后从 store 快照，避免编辑中误触发 */
const providersDraft = ref<any[]>([])
watch(() => llm.providers, (pv) => {
  providersDraft.value = (pv.providers || []).map((p: any) => ({ ...p, hasKey: !!p.apiKey, showKey: false, modelsText: (p.models || []).join(', ') }))
}, { immediate: true })

const defaultProviderModels = computed(() => {
  const dp = llm.providers.providers?.find((p: any) => p.name === llm.providers.defaultProvider)
  return dp?.models || []
})

/** 云端服务商列表（ollama 本地服务不在此展示，其管理在「Ollama 模型」tab） */
const cloudProviders = computed(() => providersDraft.value.filter(p => p.name !== 'ollama'))
/** ollama 的草稿条目：baseUrl 等仍在 draftPayload 内整体保存，避免其它服务商保存时丢失 */
const ollamaDraft = computed(() => providersDraft.value.find(p => p.name === 'ollama'))

function draftPayload() {
  return providersDraft.value.map(d => ({
    name: d.name,
    baseUrl: d.baseUrl,
    apiKey: d.apiKey || '',
    models: String(d.modelsText || '').split(/[,，]/).map((s: string) => s.trim()).filter(Boolean),
  }))
}

async function saveProvider(p: any) {
  if (!p.baseUrl) { ui.toast('baseUrl 不能为空'); return }
  await api.llm.saveProviders({
    providers: draftPayload(),
    defaultProvider: llm.providers.defaultProvider,
    defaultModel: llm.providers.defaultModel,
  })
  await llm.fetchProviders()
  ui.toast(`${providerLabel(p.name)} 配置已保存`)
}

/** 拉取该服务商在线模型列表（用表单中的 baseUrl/apiKey），与已填模型合并去重后自动保存 */
const refreshingModels = ref('')
async function refreshModels(p: any) {
  refreshingModels.value = p.name
  try {
    const res = await api.llm.providerModels(p.name, { baseUrl: p.baseUrl, apiKey: p.apiKey })
    if (!res?.online) { ui.toast('拉取失败：' + (res?.message || '服务商无响应')); return }
    const existing = String(p.modelsText || '').split(/[,，]/).map((s: string) => s.trim()).filter(Boolean)
    const added = (res.models || []).filter((m: string) => !existing.includes(m))
    p.modelsText = [...existing, ...added].join(', ')
    if (added.length) await api.llm.saveProviders({
      providers: draftPayload(),
      defaultProvider: llm.providers.defaultProvider,
      defaultModel: llm.providers.defaultModel,
    })
    await llm.fetchProviders()
    ui.toast(added.length ? `已拉取 ${res.models.length} 个模型，新增 ${added.length} 个` : `在线模型已全部在列表中（${existing.length} 个）`)
  } catch (e: any) {
    ui.toast('拉取失败：' + (e?.message || e))
  } finally {
    refreshingModels.value = ''
  }
}

async function changeProvider(name: string) {
  if (!name) return
  const target = llm.providers.providers?.find((p: any) => p.name === name)
  // 当前默认模型不属于新服务商时，联动切到该服务商第一个模型，避免错配
  const keepModel = (target?.models || []).includes(llm.providers.defaultModel)
  await api.llm.saveProviders({
    providers: draftPayload(),
    defaultProvider: name,
    defaultModel: keepModel ? llm.providers.defaultModel : (target?.models?.[0] || ''),
  })
  await llm.fetchProviders()
  ui.toast(`默认服务商已切换为 ${providerLabel(name)}`)
}

/* ---------- Ollama 模型 tab ---------- */
const aiTab = ref<'providers' | 'ollama' | 'nodes'>('providers')
const ollamaProbing = ref(false)
const ollamaOnline = ref(false)
const ollamaModels = ref<Array<{ id: string; type: 'chat' | 'embedding'; enabled: boolean }>>([])
const embeddingEnabled = ref(false)
const embeddingModel = ref('')
const embedStatus = ref({ embedded: 0, remaining: 0, enabled: false, model: '', queuePending: 0, queueActive: 0 })
const searchQuery = ref('')
const searchHits = ref<Array<{ file_id: number; title: string; path: string; score: number }>>([])
const searched = ref(false)

const embeddingCandidates = computed(() =>
  ollamaModels.value.filter(m => m.type === 'embedding' && m.enabled).map(m => m.id)
)
const embedReady = computed(() => embedStatus.value.enabled && !!embedStatus.value.model)

async function probeOllama() {
  ollamaProbing.value = true
  try {
    const data = await api.llm.ollamaModels()
    ollamaOnline.value = !!data.online
    ollamaModels.value = data.models || []
  } catch {
    ollamaOnline.value = false
    ollamaModels.value = []
  } finally {
    ollamaProbing.value = false
  }
}

async function loadEmbedStatus() {
  try {
    const data = await api.llm.embeddingsStatus()
    embedStatus.value = data
    // 回填向量化开关与模型选择（仅当模型仍在候选列表中时保留）
    embeddingEnabled.value = !!data.enabled
    embeddingModel.value = data.model || ''
  } catch {
    /* 保持默认 */
  }
}

function switchOllamaTab() {
  aiTab.value = 'ollama'
  probeOllama()
  loadEmbedStatus()
}

function switchNodesTab() {
  aiTab.value = 'nodes'
  loadNodes()
}

async function saveOllamaBaseUrl() {
  const p = ollamaDraft.value
  if (!p) return
  if (!p.baseUrl) { ui.toast('baseUrl 不能为空'); return }
  await saveProvider(p)
  probeOllama()
}

function syncEmbeddingModelValidity() {
  // 候选变化后，当前选中模型若失效则清空，避免保存非法配置
  if (embeddingModel.value && !embeddingCandidates.value.includes(embeddingModel.value)) {
    embeddingModel.value = ''
  }
}

function toggleModelEnabled(m: { id: string; type: 'chat' | 'embedding'; enabled: boolean }) {
  m.enabled = !m.enabled
  if (!m.enabled || m.type !== 'embedding') syncEmbeddingModelValidity()
}

function toggleModelType(m: { id: string; type: 'chat' | 'embedding'; enabled: boolean }) {
  m.type = m.type === 'embedding' ? 'chat' : 'embedding'
  syncEmbeddingModelValidity()
}

async function saveOllamaConfig() {
  const enabledModels = ollamaModels.value.filter(m => m.enabled).map(m => m.id)
  if (embeddingEnabled.value && !embeddingModel.value) {
    ui.toast('请先选择一个向量模型')
    return
  }
  const modelTypes: Record<string, string> = {}
  for (const m of ollamaModels.value) modelTypes[m.id] = m.type
  const res = await api.llm.saveOllamaConfig({
    enabledModels,
    modelTypes,
    embedding: { enabled: embeddingEnabled.value, provider: 'ollama', model: embeddingModel.value },
  })
  if (res?.success === false) { ui.toast(res.message || '保存失败'); return }
  await Promise.all([llm.fetchProviders(), loadEmbedStatus()])
  ui.toast('Ollama 配置已保存')
}

async function triggerEmbedBackfill() {
  const res = await api.llm.embeddingsBackfill()
  if (res?.success === false) { ui.toast(res.message || '无法启动补向量'); return }
  ui.toast(`已入队 ${res.enqueued ?? 0} 篇待向量化`)
  loadEmbedStatus()
}

async function doEmbedSearch() {
  const q = searchQuery.value.trim()
  if (!q) return
  searched.value = true
  searchHits.value = []
  try {
    const res = await api.llm.embeddingsSearch(q)
    searchHits.value = res?.hits || []
  } catch {
    searchHits.value = []
  }
}

/* ---------- 日志管理 tab ---------- */
const logView = ref<'llm' | 'mcp' | 'service'>('llm')
const logKw = ref('')
const logStatus = ref('')
const llmLogs = ref<any[]>([])
const llmLogsTotal = ref(0)
const llmLogPage = ref(1)
const mcpLogs = ref<any[]>([])
const mcpLogsTotal = ref(0)
const svcLogs = ref<string[]>([])

const STATUS_LABELS: Record<string, string> = { success: '成功', failed: '失败', timeout: '超时', rate_limited: '限流' }
function statusLabel(s: string) {
  return STATUS_LABELS[s] || s || '-'
}
// 行展开（排错明细）与耗时格式化
const expandedLog = ref(0)
function fmtLogDur(ms?: number | null) {
  if (ms == null) return '-'
  return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms'
}

function isErrLine(l: string) {
  const s = l.toLowerCase()
  return s.includes('error') || s.includes('failed') || s.includes('fail')
}

/** 按当前二级视图加载日志；fresh=true 时重置到第一页 */
async function loadLogs(fresh = false) {
  const kw = logKw.value.trim()
  try {
    if (logView.value === 'llm') {
      if (fresh) llmLogPage.value = 1
      const out = await api.llm.logs({ page: String(llmLogPage.value), limit: '50', kw, status: logStatus.value })
      llmLogs.value = fresh ? (out.items || []) : [...llmLogs.value, ...(out.items || [])]
      llmLogsTotal.value = out.total || 0
    } else if (logView.value === 'mcp') {
      const out = await api.llm.mcpLogs(kw)
      mcpLogs.value = out.items || []
      mcpLogsTotal.value = out.total || 0
    } else {
      const out = await api.llm.serviceLogs(kw)
      svcLogs.value = out.items || []
    }
  } catch {
    /* 拉取失败保持现状，避免闪空 */
  }
}

function switchLogView(v: 'llm' | 'mcp' | 'service') {
  logView.value = v
  loadLogs(true)
}

async function loadMoreLogs() {
  llmLogPage.value++
  await loadLogs()
}

watch(settingsTab, (t) => { if (t === 'logs') loadLogs(true) })

const conc = computed(() => llm.queue.concurrency ?? 2)
const concMax = computed(() => llm.queue.capacity ?? 4)
const concRec = computed(() => llm.queue.recommendedConcurrency ?? 2)
const paused = computed(() => !!llm.queue.paused)

/** 某服务商的并发限额（未单独设置时显示全局值） */
function providerConc(name: string): number {
  const map = (llm.queue as any).providerConcurrency || {}
  return map[name] ?? conc.value
}

async function setProviderConc(name: string, n: number) {
  if (n < 1 || n > concMax.value) return
  await llm.setConcurrency(n, name)
  ui.toast(`${name} 并发已调整为 ${n}`)
}

/* ---------- 蒸馏节点池 ---------- */
const nodes = ref<any[]>([])
const checkingAll = ref(false)
const checkingNode = ref('')

const enabledNodeCount = computed(() => nodes.value.filter(n => n.enabled).length)
/** 启用节点当前并行任务总数 */
const nodeRunningSum = computed(() => nodes.value.filter(n => n.enabled).reduce((s, n) => s + (n.running || 0), 0))
/** 按服务商分组（组内启用优先、模型名字典序），供蒸馏池 tab 管理 */
const groupedNodes = computed(() =>
  [...new Set(nodes.value.map(n => n.provider))]
    .sort((a, b) => providerLabel(a).localeCompare(providerLabel(b)))
    .map(provider => ({
      provider,
      label: providerLabel(provider),
      nodes: nodes.value
        .filter(n => n.provider === provider)
        .sort((a, b) => (a.enabled !== b.enabled ? (a.enabled ? -1 : 1) : a.model.localeCompare(b.model))),
    })),
)

/* ---------- 蒸馏池模型管理（增 / 删 / 改名，提交整表到 /providers/models） ---------- */
const addingProvider = ref('')
const addModelName = ref('')
const renamingKey = ref('')
const renameValue = ref('')
const confirmDelKey = ref('')
let confirmDelTimer: ReturnType<typeof setTimeout> | null = null

function providerModels(provider: string) {
  return nodes.value.filter(n => n.provider === provider).map(n => n.model)
}

function startAddModel(p: string) {
  addingProvider.value = p
  addModelName.value = ''
}

function cancelAddModel() {
  addingProvider.value = ''
  addModelName.value = ''
}

async function confirmAddModel(p: string) {
  const name = addModelName.value.trim()
  if (!name) return
  if (providerModels(p).includes(name)) { ui.toast('该模型已存在'); return }
  try {
    await api.llm.saveProviderModels(p, [...providerModels(p), name])
    ui.toast(`已添加 ${name}（默认未启用，请打开开关参与分流）`)
    cancelAddModel()
  } catch (e: any) {
    ui.toast('添加失败：' + (e?.message || e))
  }
  await loadNodes()
}

function startRename(n: any) {
  renamingKey.value = n.provider + '|' + n.model
  renameValue.value = n.model
}

async function confirmRename(n: any) {
  const name = renameValue.value.trim()
  if (!name || name === n.model) { renamingKey.value = ''; return }
  if (providerModels(n.provider).includes(name)) { ui.toast('该模型名已存在'); return }
  try {
    await api.llm.saveProviderModels(n.provider, providerModels(n.provider).map(m => (m === n.model ? name : m)))
    ui.toast(`已改名 ${n.model} → ${name}${n.enabled ? '（改名后需重新开启启用）' : ''}`)
    renamingKey.value = ''
  } catch (e: any) {
    ui.toast('改名失败：' + (e?.message || e))
  }
  await loadNodes()
}

async function removeNode(n: any) {
  const key = n.provider + '|' + n.model
  // 二次确认：首击进入确认态（3 秒后自动复原），再击执行删除
  if (confirmDelKey.value !== key) {
    confirmDelKey.value = key
    if (confirmDelTimer) clearTimeout(confirmDelTimer)
    confirmDelTimer = setTimeout(() => { confirmDelKey.value = '' }, 3000)
    return
  }
  confirmDelKey.value = ''
  if (confirmDelTimer) clearTimeout(confirmDelTimer)
  try {
    await api.llm.saveProviderModels(n.provider, providerModels(n.provider).filter(m => m !== n.model))
    ui.toast(`已删除 ${n.model}`)
  } catch (e: any) {
    ui.toast('删除失败：' + (e?.message || e))
  }
  await loadNodes()
}

async function loadNodes() {
  try {
    nodes.value = (await api.llm.llmNodes()).nodes || []
  } catch {
    /* 拉取失败保持现状 */
  }
}

function nodeBadge(n: any) {
  if (!n.enabled) return { cls: 'off', text: '未启用', title: '' }
  if (!n.health) return { cls: 'off', text: '未检测', title: '' }
  if (n.health.healthy) return { cls: 'ok', text: '健康', title: '' }
  const cooling = n.health.cooldownUntil && n.health.cooldownUntil > Date.now()
  return { cls: 'bad', text: cooling ? '冷却中' : '异常', title: n.health.error || '' }
}

async function toggleNode(n: any) {
  await api.llm.llmNodeUpdate(n.provider, n.model, { enabled: !n.enabled })
  ui.toast(`${providerLabel(n.provider)} · ${n.model} 已${n.enabled ? '停用' : '启用，将参与蒸馏分流'}`)
  await loadNodes()
}

async function setNodeWeight(n: any, w: number) {
  if (w < 1 || w > 16) return
  await api.llm.llmNodeUpdate(n.provider, n.model, { weight: w })
  await loadNodes()
}

async function checkNodeOne(n: any) {
  checkingNode.value = n.provider + n.model
  try {
    const res = await api.llm.llmNodeCheck(n.provider, n.model)
    const r = (res.results || [])[0]
    ui.toast(r ? (r.healthy ? `${n.model} 存活` : `${n.model} 不可用${r.error ? '：' + r.error : ''}`) : '无检测结果')
  } catch (e: any) {
    ui.toast('检测失败：' + (e?.message || e))
  } finally {
    checkingNode.value = ''
  }
  await loadNodes()
}

async function checkAllNodes() {
  checkingAll.value = true
  try {
    const res = await api.llm.llmNodeCheck()
    const results = res.results || []
    const ok = results.filter((r: any) => r.healthy).length
    ui.toast(`检测完成：${ok}/${results.length} 个启用节点存活`)
  } catch (e: any) {
    ui.toast('检测失败：' + (e?.message || e))
  } finally {
    checkingAll.value = false
  }
  await loadNodes()
}

async function loadAgents() {
  try {
    agentRoots.value = await api.scan.agents()
  } catch {
    agentRoots.value = []
  }
}

async function refresh() {
  await Promise.all([
    settings.fetchConfig(),
    settings.fetchRoots(),
    settings.fetchScanStatus(),
    llm.fetchQueue(),
    llm.fetchProviders(),
    loadNodes()
  ])
  autotag.value = settings.config['ai.autoTag']?.value ?? true
  try {
    const data = await api.files.list({ status: 'deleted', limit: '100' })
    deleted.value = data.items || []
  } catch {
    deleted.value = []
  }
  await loadGate()
  await loadAgents()
}

async function loadGate() {
  const c = settings.config
  gate.value.enabled = c['gate.enabled']?.value ?? true
  gate.value.minSize = c['gate.minSize']?.value ?? 512
  gate.value.minChars = c['gate.minChars']?.value ?? 300
  gate.value.codeRatio = c['gate.codeRatio']?.value ?? 0.6
  gate.value.minSizeEnabled = c['gate.minSizeEnabled']?.value ?? true
  gate.value.minCharsEnabled = c['gate.minCharsEnabled']?.value ?? true
  gate.value.codeRatioEnabled = c['gate.codeRatioEnabled']?.value ?? true
  gate.value.excludeDirsEnabled = c['gate.excludeDirsEnabled']?.value ?? true
  gate.value.filenameWhitelistEnabled = c['gate.filenameWhitelistEnabled']?.value ?? true
  gate.value.keywordsEnabled = c['gate.keywordsEnabled']?.value ?? true
  gate.value.excludeDirsText = (c['gate.excludeDirs']?.value || []).join(', ')
  gate.value.whitelistText = (c['gate.filenameWhitelist']?.value || []).join(', ')
  gate.value.keywordsText = (c['gate.keywords']?.value || []).join(', ')
  gate.value.blacklistText = (c['gate.blacklist']?.value || []).join(', ')
  gate.value.blacklistEnabled = c['gate.blacklistEnabled']?.value ?? true
  gate.value.pathWhitelistText = (c['gate.pathWhitelist']?.value || []).join(', ')
  gate.value.pathWhitelistEnabled = c['gate.pathWhitelistEnabled']?.value ?? true
  try {
    const out = await api.gate.records('skipped')
    gateTotal.value = out.total || 0
    gateRecords.value = out.items || []
  } catch {
    gateTotal.value = 0
    gateRecords.value = []
  }
  try {
    const out = await api.gate.records('restored')
    exemptTotal.value = out.total || 0
    exemptRecords.value = out.items || []
  } catch {
    exemptTotal.value = 0
    exemptRecords.value = []
  }
  try {
    archives.value = await api.gate.archives()
  } catch {
    archives.value = []
  }
  await loadGateValidity()
}

function fmtSize(n: number) {
  return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'
}

function openCsv(url: string) {
  window.open(url, '_blank')
}

async function archiveAll() {
  try {
    const out = await api.gate.archive()
    ui.toast(`已按月存档 ${out.archived} 条记录 → ${out.files.join('、') || '（无变更）'}`)
  } catch (e: any) {
    ui.toast('存档失败：' + (e?.message || e))
  }
  await loadGate()
  await settings.fetchScanStatus()
}

async function toggleGate() {
  gate.value.enabled = !gate.value.enabled
  await saveGate(true)
}

/** 单规则开关：切换后立即静默保存 */
async function toggleRule(f: 'minSizeEnabled' | 'minCharsEnabled' | 'codeRatioEnabled' | 'excludeDirsEnabled' | 'filenameWhitelistEnabled' | 'keywordsEnabled' | 'blacklistEnabled' | 'pathWhitelistEnabled') {
  gate.value[f] = !gate.value[f]
  await saveGate(true)
}

async function saveGate(silent = false) {
  await settings.updateConfig({
    'gate.enabled': { value: gate.value.enabled },
    'gate.minSize': { value: Number(gate.value.minSize) || 0 },
    'gate.minChars': { value: Number(gate.value.minChars) || 0 },
    'gate.codeRatio': { value: Number(gate.value.codeRatio) || 0 },
    'gate.minSizeEnabled': { value: gate.value.minSizeEnabled },
    'gate.minCharsEnabled': { value: gate.value.minCharsEnabled },
    'gate.codeRatioEnabled': { value: gate.value.codeRatioEnabled },
    'gate.excludeDirsEnabled': { value: gate.value.excludeDirsEnabled },
    'gate.filenameWhitelistEnabled': { value: gate.value.filenameWhitelistEnabled },
    'gate.keywordsEnabled': { value: gate.value.keywordsEnabled },
    'gate.excludeDirs': { value: gate.value.excludeDirsText.split(/[,，]/).map((s: string) => s.trim()).filter(Boolean) },
    'gate.filenameWhitelist': { value: gate.value.whitelistText.split(/[,，]/).map((s: string) => s.trim()).filter(Boolean) },
    'gate.keywords': { value: gate.value.keywordsText.split(/[,，]/).map((s: string) => s.trim()).filter(Boolean) },
    'gate.blacklist': { value: gate.value.blacklistText.split(/[,，]/).map((s: string) => s.trim()).filter(Boolean) },
    'gate.blacklistEnabled': { value: gate.value.blacklistEnabled },
    'gate.pathWhitelist': { value: gate.value.pathWhitelistText.split(/[,，]/).map((s: string) => s.trim()).filter(Boolean) },
    'gate.pathWhitelistEnabled': { value: gate.value.pathWhitelistEnabled }
  })
  await loadGateValidity()
  if (!silent) {
    const bad = (gateValidity.value?.fields || []).filter((f: any) => f.enabled && (f.issues || []).length > 0)
    const n = bad.reduce((s: number, f: any) => s + f.issues.length, 0)
    ui.toast(n > 0 ? `门禁配置已保存；注意：${n} 条无效配置不会生效（已标出，悬停查看原因）` : '门禁配置已保存，新扫描生效')
  }
}

async function restoreGate(r: any) {
  try {
    const out = await api.gate.restore(r.id)
    if (out?.success === false) {
      ui.toast('恢复失败：' + (out.message || '未知错误'))
      return
    }
    ui.toast(`已恢复「${r.title || r.name}」入库，进入精炼队列`)
  } catch (e: any) {
    ui.toast('恢复失败：' + (e?.message || e))
  }
  await loadGate()
  await settings.fetchScanStatus()
}

async function removeGateRecord(r: any) {
  await api.gate.removeRecord(r.id)
  ui.toast('已删除过滤记录')
  await loadGate()
}

async function unexemptRecord(r: any) {
  await api.gate.removeRecord(r.id)
  ui.toast(`已取消「${r.title || r.name}」的豁免，下次全量重扫重新评估`)
  await loadGate()
}

async function doSearchArchives() {
  const q = archiveQuery.value.trim()
  archiveSearched.value = true
  if (!q) {
    archiveResults.value = []
    archiveSearched.value = false
    return
  }
  try {
    const out = await api.gate.searchArchives(q, archiveMonth.value || undefined)
    archiveResults.value = out.results || []
  } catch {
    archiveResults.value = []
  }
}

async function confirmAddRoot() {
  const p = newRoot.value.trim()
  if (!p) {
    ui.toast('请输入扫描根的绝对路径')
    return
  }
  try {
    await settings.addRoot(p)
    newRoot.value = ''
    addingRoot.value = false
    ui.toast('已新增扫描根并执行全量扫描')
    await settings.fetchScanStatus()
  } catch (e: any) {
    ui.toast('新增失败：' + (e?.message || e))
  }
}

async function toggleRoot(r: any) {
  await settings.toggleRoot(r.id, !r.enabled)
  ui.toast(r.enabled ? `已停用扫描根 ${r.path}` : `已启用扫描根 ${r.path}`)
  await loadAgents()
}

/** Agent 目录芯片：未挂载则添加扫描根，已挂载则切换启停 */
async function toggleAgentRoot(a: any) {
  try {
    if (a.rootId) {
      await settings.toggleRoot(a.rootId, !a.enabled)
      ui.toast(`${a.name} 扫描根已${a.enabled ? '停用' : '启用'}`)
    } else {
      await settings.addRoot(a.path)
      ui.toast(`已挂载 ${a.name}（${a.path}），后台全量扫描中`)
      await settings.fetchScanStatus()
    }
  } catch (e: any) {
    ui.toast('操作失败：' + (e?.message || e))
  }
  await loadAgents()
}

async function rescan(r: any) {
  await settings.rescanRoot(r.id)
  ui.toast(`已对 ${r.path} 执行全量重扫`)
  await settings.fetchScanStatus()
}

async function removeRoot(r: any) {
  await settings.removeRoot(r.id)
  ui.toast(`已移除扫描根 ${r.path}`)
}

async function changeModel(m: string) {
  if (!m) return
  await settings.updateConfig({ 'ai.defaultModel': { value: m } })
  await llm.fetchProviders()
  ui.toast(`默认模型已切换为 ${m}`)
}

async function toggleAutotag() {
  autotag.value = !autotag.value
  await settings.updateConfig({ 'ai.autoTag': { value: autotag.value } })
  ui.toast(autotag.value ? '自动标注已开启' : '自动标注已关闭')
}

async function setConc(n: number) {
  if (n < 1 || n > concMax.value) return
  await llm.setConcurrency(n)
  ui.toast(`队列并发已调整为 ${n}`)
}

async function togglePause() {
  if (paused.value) await llm.resume()
  else await llm.pause()
  ui.queuePaused = !paused.value
  ui.toast(paused.value ? '队列已恢复 · 精炼继续' : '队列已暂停 · 进行中的精炼已挂起')
}

async function restoreDeleted(f: any) {
  await api.files.batch([f.id], 'restore')
  ui.toast(`已恢复「${f.title || f.name}」`)
  await refresh()
}

async function purgeOne(f: any) {
  await api.files.purgeOne(f.id)
  ui.toast('已彻底删除该文件及索引记录')
  await refresh()
}

onMounted(refresh)
</script>
