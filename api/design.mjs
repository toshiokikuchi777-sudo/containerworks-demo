// ============================================================
//  CONTAINER DESIGN ENGINE — Vercel Serverless Function
//  studio.html から POST /design（vercel.jsonで /api/design に転送）を受け、
//  Claudeに「設計JSON」を生成させて返す。
//  APIキーはVercelの環境変数(ANTHROPIC_API_KEY)に置く＝クライアントに出さない。
//
//  必要な環境変数：
//    ANTHROPIC_API_KEY = sk-ant-...   （必須）
//    MODEL             = claude-opus-4-8  （任意・既定値あり）
//    GATE_HASH         = 入場コードのSHA-256（任意・既定は vsw2026 のハッシュ）
// ============================================================

const MODEL = process.env.MODEL || 'claude-opus-4-8';
// APIの無断直叩き対策（ソフトガード）：studio.html が送る x-vsw-gate ヘッダを照合。
const GATE_HASH = process.env.GATE_HASH || '4e023c09fc9e3c096f0d5a28671d62f8c803241e60902770da5910591a7b6c2d';

// ---- 設計JSONのスキーマ（= studio.html の buildFromPlan が理解する語彙）----
const PLAN_SCHEMA = {
  type:'object',
  required:['meta','site','modules'],
  properties:{
    meta:{ type:'object', required:['name','grade','use'],
      properties:{ name:{type:'string'}, grade:{enum:['ume','take','matsu']}, use:{type:'string'} } },
    site:{ type:'object', required:['width','depth'],
      properties:{ width:{type:'number'}, depth:{type:'number'} } },
    modules:{ type:'array', minItems:1, maxItems:8, items:{
      type:'object', required:['id','size','x','z','level','rot','color','faces'],
      properties:{
        id:{type:'string'},
        size:{enum:['20ft','40ft'], description:'20ft=6.06×2.44m / 40ft=12.19×2.44m。高さは常に2.59m'},
        x:{type:'number', description:'敷地中心を原点としたモジュール中心のX(m)'},
        z:{type:'number', description:'同Z(m)。手前(来場者側)が +Z'},
        level:{type:'integer', minimum:0, maximum:2, description:'段積み。0=地上, 1=2階, 2=3階。y=level×2.59m'},
        rot:{enum:[0,90], description:'0=長辺がX方向 / 90=長辺がZ方向'},
        color:{enum:['red','blue','green'], description:'塗装色。段ごとに変えると見栄えが良い'},
        faces:{ type:'object', description:'各面の処理。front=+Z(長辺・来場者側) back=-Z right=+X(短辺) left=-X(短辺)',
          properties:{
            front:{enum:['storefront','windows','wall','open']},
            back:{enum:['storefront','windows','wall','open']},
            right:{enum:['cargo','windows','wall','open']},
            left:{enum:['cargo','windows','wall','open']}
          } },
        door:{ type:'object', properties:{ face:{enum:['front','back']}, width:{type:'number'} },
          description:'主出入口。storefront面に開ける' },
        interior:{ type:'object', properties:{
          ceiling:{type:'number'}, light:{type:'boolean'},
          furniture:{ type:'array', items:{ type:'object', required:['family','x','z'],
            properties:{ family:{enum:['counter','kitchen','seating','table','desk','shelf','bed','bath','plant']},
              x:{type:'number'}, z:{type:'number'}, w:{type:'number'}, d:{type:'number'}, n:{type:'integer'}, s:{type:'number'} } } }
        } }
      } } },
    site_features:{ type:'array', items:{
      type:'object', required:['type'],
      properties:{ type:{enum:['terrace','tree','pad','stair','sign']},
        x:{type:'number'}, z:{type:'number'}, w:{type:'number'}, d:{type:'number'}, s:{type:'number'},
        top:{type:'number'}, text:{type:'string'}, bg:{type:'string'}, size:{type:'number'}, y:{type:'number'} } } }
  }
};

const SYSTEM = `あなたは株式会社コンテナワークスの建築設計AIです。ISOコンテナ(20ft/40ft)を組み合わせた建物を設計し、emit_plan ツールで設計データ(JSON)として出力します。

【絶対に守る寸法】20ft=長6.06×幅2.44m / 40ft=長12.19×幅2.44m / 高さ常に2.59m。コンテナは必ずこの規格寸法。
【座標】敷地中心が原点。手前(来場者側)が +Z。モジュールのx,zは「中心」座標。隣接して連結するときは幅2.44m/長さ分だけ離して中心を置く(重なり/隙間を作らない)。
【段積み】上階(level1,2)は下階の真上か一部だけ載せてキャンチレバー(張り出し)にできる。屋上はterraceにしてstairで上がれるようにする。
【面の使い分け】来場者から見える長辺(front=+Z)は storefront(ガラス窓+入口) で開放。短辺(right/left)は cargo(貨物扉) か wall。連結して内部がつながる面は open で壁を抜く。
【グレード】ume=1棟・最小 / take=2棟連結・横長 / matsu=3棟・2階建て(段積み+屋上テラス+外階段)。
【内部】用途に応じて furniture を配置(カフェ=counter+seating+kitchen、オフィス=desk+shelf、住居=bed+bath、サウナ=bath)。家具のx,zはモジュール局所座標(中心0)。
【設計判断】建ぺい率・動線・採光・連結の構造的整合を考慮し、実際に建てられる現実的な構成にする。装飾でなく"設計"として根拠ある配置にすること。

必ず emit_plan を1回だけ呼ぶ。説明文は不要。`;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST /design のみ' }); return; }

  // ソフトガード：正規のアプリ(studio.html)以外からの直叩きを弾く
  const gate = req.headers['x-vsw-gate'];
  if (gate !== GATE_HASH) { res.status(401).json({ error: 'unauthorized' }); return; }

  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) { res.status(500).json({ error: 'ANTHROPIC_API_KEY 未設定（Vercelの環境変数に設定してください）' }); return; }

  const q = (req.body && typeof req.body === 'object') ? req.body
          : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();

  const user = `次の条件でコンテナ建築を設計してください。
用途: ${q.use || 'カフェ'}
グレード: ${q.grade || 'ume'}（ume=1棟 / take=2棟 / matsu=3棟2階）
敷地: 間口${q.site?.width || 16}m × 奥行${q.site?.depth || 16}m
要望: ${q.notes || '（特になし）'}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 4096, system: SYSTEM,
        tools: [{ name: 'emit_plan', description: 'コンテナ建築の設計データを出力する', input_schema: PLAN_SCHEMA }],
        tool_choice: { type: 'tool', name: 'emit_plan' },
        messages: [{ role: 'user', content: user }]
      })
    });
    const data = await r.json();
    if (!r.ok) { res.status(502).json({ error: 'Anthropic API', detail: data }); return; }
    const tool = (data.content || []).find(c => c.type === 'tool_use');
    if (!tool) { res.status(502).json({ error: 'no tool_use', detail: data }); return; }
    res.status(200).json(tool.input);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
