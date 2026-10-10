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
          <li>匿名资料：系统生成的匿名 ID、你填写的昵称；用于保存与同步你的路书。</li>
          <li>
            账号（注册后才有）：邮箱、密码，以及选填的手机号，只用来登录、防止重复注册和找回账号。邮箱的用途见下面「邮箱」一节；手机号不发短信、不做营销，也没有发给第三方的功能。服务端只保存手机号的加密摘要（用来查找账号）和打码后的号码（如
            +86 138****5678，用来在页面上显示）；密码只保存不可还原的摘要；恢复码只保存摘要，原文只在生成时显示一次。
          </li>
          <li>邮箱验证码：注册、重设密码、换邮箱时发到你邮箱的 6 位数字，15 分钟内有效、只能用一次；服务端只保存它的摘要和发送时间，用来防止频繁发送。</li>
          <li>登录状态：浏览器里的一个登录 Cookie（不能被网页脚本读取），服务端只保存它的摘要、设备的浏览器类型和最近使用时间，用于「在所有设备退出」。</li>
          <li>安全记录：登录失败、验证码发送和输错的次数，按邮箱摘要、手机号摘要和网络地址摘要计数，用来防止猜密码和滥发邮件；不保存原始邮箱、号码或 IP。</li>
          <li>路书与生成输入：目的地、天数、偏好、你粘贴的攻略文字或链接、上传的截图；会发送给当前配置的大模型服务用于生成路书或识别文字。</li>
          <li>打卡：评价、排队、花费、短评、照片；若你同意定位，还包括打卡那一刻的经纬度、定位精度、坐标系标注和浏览器标识，用于判断「到达验证」。</li>
          <li>使用统计：路书曝光、点击；用于统计路书效果，不用于个性化广告。</li>
          <li>服务日志：生成耗时、错误、调用的模型名称；用于排查故障和成本控制。</li>
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-extrabold">邮箱</h2>
        <p>
          注册时要填邮箱，并输入发到邮箱的验证码，确认邮箱是你的。邮箱只用来：登录；发验证码（注册、重设密码、换邮箱）；发账号安全通知（密码被重设、邮箱被更换、有人用你的邮箱注册）。不发营销邮件，也不把邮箱给第三方做别的用途。
        </p>
        <p>
          服务端把邮箱加密保存（用来给你发信），另存一份不可还原的摘要（用来查找账号、防止重复注册），页面和运营后台只显示打码后的样子（如
          ab***@qq.com）。发信通过邮件服务商完成：
          {TODO('邮件服务商名称与发件域名')}，服务商只收到收件地址和邮件内容。
        </p>
        <p>
          换邮箱要输入当前密码，并验证新邮箱；换好后，旧邮箱会收到一封通知。账号注销时，邮箱密文立即清除，摘要随账号一起标记删除，邮箱可以重新注册；运营备份中的副本按备份周期清除。
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-extrabold">手机号</h2>
        <p>
          手机号是选填的，填了也能用来登录。我们不发短信验证码，无法确认号码属于你本人，请用你自己的号码。忘了密码时，优先用邮箱验证码重设；没有绑定邮箱的，用注册时拿到的恢复码重设；恢复码都用完了，可以联系我们，核实是本人后补发一个一次性恢复码（核实方式：
          {TODO('客服核实流程与联系方式')}）。
        </p>
        <p>
          以后如接入短信验证，会先在这里说明短信服务商和用途：{TODO('短信服务商名称')}
          。账号注销后，手机号摘要随账号一起标记删除，号码可以重新注册；运营备份中的副本按备份周期清除。
        </p>
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
          当前版本没有自动到期删除；数据保存到你注销为止。保存期限：{TODO('各类数据的保存期限')}。你可以在「我的 → 账号」或「我的 →
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
