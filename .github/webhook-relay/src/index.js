// Cloud Mail → 飞书(Lark) Webhook 格式转换中继
//
// 背景：Cloud Mail 的 webhook 发送固定的 JSON（无 msg_type 顶层字段），
//       飞书自定义机器人要求 {"msg_type":"text","content":{"text":"..."}}，直接对接必然报 code:9499。
//       本 Worker 负责：接收 Cloud Mail 推送 → 提取邮件字段 → 组装飞书格式 → 转发。
//
// 部署：由 deploy-lark-hook.yml 执行，飞书 Hook URL 通过 --var FEISHU_WEBHOOK 注入（放 GitHub Secret，禁止硬编码！）。
// 可选：WEBHOOK_SECRET 用于校验 Cloud Mail 发出的 Authorization 头（与 Cloud Mail 设置里的第二个输入框对应）。
export default {
  async fetch(request, env) {
    // 健康检查（方便浏览器/监控验证）
    if (request.method === 'GET') {
      return new Response('webhook-relay ok', { status: 200 });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    if (!env.FEISHU_WEBHOOK) {
      return new Response('FEISHU_WEBHOOK not configured', { status: 500 });
    }

    // 可选鉴权：若部署时注入了 WEBHOOK_SECRET，则校验 Cloud Mail 的 Authorization 头
    if (env.WEBHOOK_SECRET && request.headers.get('Authorization') !== env.WEBHOOK_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }

    let data;
    try {
      data = await request.json();
    } catch (e) {
      return new Response('Invalid JSON', { status: 400 });
    }

    // 提取 Cloud Mail 字段（原始结构：emailId/sendEmail/sendName/toEmail/toName/subject/text/content/code/createTime）
    const sender = data.sendName ? `${data.sendName} <${data.sendEmail || ''}>` : (data.sendEmail || '未知发件人');
    const subject = data.subject || '无主题';
    const code = data.code ? `\n🔑 验证码: ${data.code}` : '';
    const time = data.createTime ? `\n🕒 时间: ${data.createTime}` : '';
    const rawText = data.text || '';
    const preview = rawText ? `\n📄 内容预览: ${rawText.slice(0, 200)}${rawText.length > 200 ? '…' : ''}` : '';

    const message = `📬 【收到新邮件】\n👤 发件人: ${sender}\n📌 主题: ${subject}${code}${time}${preview}`;

    // 转发到飞书
    let resp;
    try {
      resp = await fetch(env.FEISHU_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg_type: 'text', content: { text: message } })
      });
    } catch (e) {
      // 网络错误 → 5xx，让 Cloud Mail 走 webhookRetry 重试
      return new Response(`relay fetch error: ${e.message}`, { status: 502 });
    }

    let respBody = '';
    try {
      respBody = await resp.text();
    } catch (e) { /* ignore */ }

    // 关键坑：飞书对非法参数返回 HTTP 200 + body {"code":9499,...}。
    // Cloud Mail 只用 res.ok 判断成功，因此必须解析 body；code!=0 时返回 5xx 触发它的重试机制。
    let feishuErr = null;
    try {
      const j = JSON.parse(respBody);
      if (j && typeof j.code === 'number' && j.code !== 0) {
        feishuErr = `feishu code=${j.code} msg=${j.msg || ''}`;
      }
    } catch (e) { /* 非 JSON，交由下方状态码判断 */ }

    if (!resp.ok || feishuErr) {
      return new Response(feishuErr || respBody || `feishu http ${resp.status}`, { status: 502 });
    }

    return new Response('ok');
  }
};