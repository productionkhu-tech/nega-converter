// electron-builder가 draft로 올린 최신 릴리스를 찾아 자동으로 공개(publish) 전환.
// `npm run release`의 마지막 단계로 실행됨. GH_TOKEN 환경변수 필요.
const https = require('https');

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const OWNER = 'productionkhu-tech';
const REPO = 'nega-converter';

if (!token) {
  console.error('[publish-release] GH_TOKEN 환경변수가 없습니다. 공개 전환을 건너뜁니다.');
  process.exit(0); // 빌드 자체는 성공이므로 0으로 종료
}

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: 'api.github.com',
        path,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'nega-converter-release',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
        }
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(buf ? JSON.parse(buf) : {});
          } else {
            reject(new Error(`${res.statusCode}: ${buf}`));
          }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const releases = await api('GET', `/repos/${OWNER}/${REPO}/releases?per_page=15`);
  const draft = releases.find((r) => r.draft);
  if (!draft) {
    console.log('[publish-release] 공개할 draft 릴리스가 없습니다.');
    return;
  }
  const updated = await api('PATCH', `/repos/${OWNER}/${REPO}/releases/${draft.id}`, {
    draft: false,
    make_latest: 'true'
  });
  console.log(`[publish-release] 공개 완료: ${updated.tag_name}`);
  console.log(`[publish-release] ${updated.html_url}`);
})().catch((e) => {
  console.error('[publish-release] 실패:', e.message);
  process.exit(1);
});
