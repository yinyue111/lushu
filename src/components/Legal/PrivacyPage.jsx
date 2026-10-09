import { useState } from 'react';
import { hasLocationConsent, withdrawLocationConsent, LOCATION_POLICY_VERSION } from '../../lib/locationConsent.js';
import { Button } from '../ui/button';

// 隐私说明草案：只写代码实际做的事；主体、联系方式、保存期限等需运营与法务确认，留空标注。
const TODO = (text) => <mark className="rounded bg-lemon-soft px-1 font-semibold text-lemon-ink">【待确认：{text}】</mark>;

export default function PrivacyPage({ onBack }) {
  const [consented, setConsented] = useState(() => hasLocationConsent());
  return (
    <article className="mx-auto max-w-3xl space-y-6 px-4 py-8 text-copy leading-relaxed" aria-labelledby="privacy-title">
      <header className="space-y-2">
        <p className="badge badge-orange inline-block">草案 · 未经法务审核，不构成正式隐私政策</p>
        <h1 id="privacy-title" className="text-2xl font-extrabold">
          隐私说明（草案）
        </h1>
        <p className="text-meta text-muted">
          版本 {LOCATION_POLICY_VERSION}。运营主体：{TODO('公司全称与联系方式')}
        </p>
      </header>

      <section className="space-y-2">
        <h2 className="text-lg font-extrabold">我们处理哪些信息、用来做什么</h2>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>匿名资料：服务端生成的匿名 ID、你填写的昵称；用于保存与同步你的路书。</li>
          <li>路书与生成输入：目的地、天数、偏好、你粘贴的攻略文字或链接、上传的截图；会发送给当前配置的大模型服务用于生成路书或识别文字。</li>
          <li>打卡：评价、排队、花费、短评、照片；若你同意定位，还包括打卡那一刻的经纬度、定位精度、坐标系标注和浏览器标识，用于判断「到达验证」。</li>
          <li>使用统计：路书曝光、点击；用于统计路书效果，不用于个性化广告。</li>
          <li>服务日志：生成耗时、错误、调用的模型名称；用于排查故障和成本控制。</li>
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-extrabold">定位</h2>
        <p>
          只有你在打卡时点「用 GPS
          证明我到了」并在说明弹窗中同意后，才会请求浏览器定位，且每次只读取一次；不后台定位、不连续追踪。不同意也可以打卡，记为普通反馈。
        </p>
        <div className="flex flex-wrap items-center gap-3 rounded-card bg-canvas p-3.5">
          <span>本机定位同意状态：{consented ? '已同意' : '未同意'}</span>
          {consented && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                withdrawLocationConsent();
                setConsented(false);
              }}
            >
              撤回定位同意
            </Button>
          )}
        </div>
        <p className="text-meta text-muted">撤回只影响之后的打卡；已上传的打卡位置可通过注销删除。</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-extrabold">第三方服务</h2>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>大模型服务：{TODO('最终选定的模型服务商名称、所在地及备案情况')}</li>
          <li>地图与地理编码：配置后使用高德开放平台或天地图；开发环境使用 OpenStreetMap 底图。</li>
          <li>内容安全审核：{TODO('境内内容安全服务商名称')}</li>
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-extrabold">保存期限与你的权利</h2>
        <p>
          当前版本没有自动到期删除；数据保存到你注销为止。保存期限：{TODO('各类数据的保存期限')}。你可以在「我的 →
          资料与隐私」导出资料，或注销并删除服务中的资料、照片和打卡记录（运营备份中的副本按备份周期清除：
          {TODO('备份保留周期')}）。
        </p>
        <p>数据存储地点：{TODO('服务器所在地区；是否存在数据出境')}</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-extrabold">AI 生成内容</h2>
        <p>
          路书由 AI 根据你的输入与已核验的地点资料生成，页面上会标注「AI 生成」。营业时间、价格等仅在有来源和有效期时显示为「已核验」，其余请出行前自行确认。
        </p>
      </section>

      {onBack && (
        <Button variant="soft" onClick={onBack}>
          返回
        </Button>
      )}
    </article>
  );
}
