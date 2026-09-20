<template>
  <article class="copyright-page">
    <header class="copyright-header">
      <NuxtLink to="/" class="back-link">← 返回搜索</NuxtLink>
      <p class="eyebrow">盘搜 · Copyright</p>
      <h1>版权与免责声明</h1>
      <p class="lead">盘搜提供公开网络信息的检索、索引、聚合和第三方链接跳转服务。</p>
    </header>

    <section class="copyright-card">
      <h2>服务说明</h2>
      <p>
        盘搜主要展示第三方来源返回的资源标题、描述和链接，不主动上传、制作或托管第三方文件内容。
        搜索结果的准确性、时效性、可用性及合法性由相关来源或用户负责；外部网站和资源不由盘搜控制。
      </p>

      <h2>用户须知</h2>
      <p>
        网络公开信息不等于无版权。用户应自行确认资源已经获得合法授权，不得利用本站从事侵权、盗版、传播违法信息或其他违法活动。
      </p>

      <h2>侵权投诉</h2>
      <p>
        如果你是权利人，认为本站展示的某条结果侵犯了你的合法权益，请发送邮件至
        <a href="mailto:pansou12345@163.com">pansou12345@163.com</a>。
      </p>
      <p>为了便于核实，请在邮件中提供：</p>
      <ul>
        <li>权利人姓名（或单位名称）、联系方式；</li>
        <li>作品名称及具体涉嫌侵权的结果链接；</li>
        <li>权属证明和侵权初步证明材料；</li>
        <li>对通知内容真实性负责的声明；</li>
        <li>如由代理人提交，请附授权证明。</li>
      </ul>
      <p>
        对于材料完整、能够准确定位的投诉，盘搜将及时核实，并视情况采取删除、屏蔽或断开相关链接等措施。
        恶意或虚假投诉造成损失的，投诉人应依法承担相应责任。
      </p>
    </section>

    <p class="copyright-note">本页面仅用于服务说明，不构成对任何具体资源合法性的确认或法律意见。</p>
  </article>
</template>

<script setup lang="ts">
useHead({
  title: "版权与免责声明 - 盘搜",
  meta: [{ name: "robots", content: "noindex,follow" }],
});
</script>

<style scoped>
.copyright-page {
  max-width: 780px;
  margin: 0 auto;
  padding: 28px 0 20px;
}

.copyright-header {
  padding: 8px 4px 24px;
}

.back-link {
  display: inline-flex;
  color: var(--primary);
  font-size: 14px;
  text-decoration: none;
}

.eyebrow {
  margin: 32px 0 8px;
  color: var(--primary);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}

h1 {
  margin: 0;
  color: var(--text-primary);
  font-size: clamp(28px, 5vw, 42px);
  line-height: 1.2;
}

.lead {
  max-width: 620px;
  margin: 14px 0 0;
  color: var(--text-secondary);
  font-size: 16px;
  line-height: 1.75;
}

.copyright-card {
  padding: 28px 32px;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  background: var(--bg-primary);
  box-shadow: var(--shadow-sm);
}

h2 {
  margin: 0 0 10px;
  color: var(--text-primary);
  font-size: 18px;
  line-height: 1.5;
}

h2:not(:first-child) {
  margin-top: 28px;
}

p,
li {
  color: var(--text-secondary);
  font-size: 15px;
  line-height: 1.8;
}

p { margin: 0 0 14px; }

ul {
  margin: 0 0 14px;
  padding-left: 1.4em;
}

a {
  color: var(--primary);
  overflow-wrap: anywhere;
}

.copyright-note {
  margin: 18px 4px 0;
  color: var(--text-tertiary);
  font-size: 12px;
  text-align: center;
}

@media (max-width: 640px) {
  .copyright-page { padding-top: 12px; }
  .copyright-card { padding: 22px 20px; }
}
</style>
