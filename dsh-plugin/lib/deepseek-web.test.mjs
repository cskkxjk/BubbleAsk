/**
 * deepseek-web.test.mjs — 真机自检（会真的拉起浏览器、真的往 chat.deepseek.com 发一条消息）。
 *
 *   node lib/deepseek-web.test.mjs                  # 用默认 profile（%APPDATA%\BubbleAsk\edge-profile）
 *   node lib/deepseek-web.test.mjs "D:\some\profile"  # 用指定 profile 目录
 *
 * 退出码：0 = stage 是 sent 或 prefilled（prefilled 表示页面没登录，问题只填进输入框）；
 *         1 = 其它任何情况。
 */

import { detectBrowsers, sendToDeepSeekWeb, shutdown } from './deepseek-web.mjs';

const profileDir = typeof process.argv[2] === 'string' && process.argv[2].trim() ? process.argv[2].trim() : '';
const prompt = `【BubbleAsk 自检】这是一条自动化自检消息（${new Date().toISOString()}）。请只回复 OK 两个字母，不要任何其它内容。`;

function line(text) {
  process.stdout.write(text + '\n');
}

line('== 检测到的浏览器 ==');
const browsers = detectBrowsers();
if (browsers.length === 0) {
  line('（一个都没检测到）');
}
for (const browser of browsers) {
  line(`- ${browser.id}\t${browser.name}\t${browser.path}`);
}

line('');
line('== 发送自检消息 ==');
line(`prompt: ${prompt}`);
line(`profileDir: ${profileDir || '（默认 %APPDATA%\\BubbleAsk\\edge-profile）'}`);
line('');

let result = null;
try {
  result = await sendToDeepSeekWeb({
    prompt,
    config: profileDir ? { profileDir } : undefined,
    log: (message) => line('[log] ' + message),
  });
} catch (error) {
  // 模块本身不应该抛到这里；真抛了也要把结果写成能看懂的样子。
  result = {
    ok: false,
    stage: 'cdp',
    detail: '未捕获异常：' + (error && error.stack ? error.stack : String(error)),
  };
}

line('');
line('== 最终结果 ==');
line(JSON.stringify(result, null, 2));

await shutdown();

const stage = result && result.stage;
const passed = stage === 'sent' || stage === 'prefilled';
line('');
line(passed ? `PASS（stage=${stage}）` : `FAIL（stage=${stage}）`);
process.exit(passed ? 0 : 1);
