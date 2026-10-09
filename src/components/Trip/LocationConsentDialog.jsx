import { Dialog, DialogContent } from '../ui/dialog';
import { Button } from '../ui/button';

// 单独征得定位同意：在浏览器权限弹窗之前说明用途、保存方式与撤回方式。
/** @param {{ open: boolean, onAgree: () => void, onDecline: () => void }} props */
export default function LocationConsentDialog({ open, onAgree, onDecline }) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onDecline();
      }}
    >
      <DialogContent title="使用你的位置来验证到达？" description="只有点「同意并定位」后才会请求浏览器定位。">
        <div className="space-y-3 text-copy">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>用途：仅在你主动打卡时读取一次当前位置，与该站点坐标比对，判断是否计入「到达验证」。</li>
            <li>上传内容：经纬度、定位精度、坐标系标注和浏览器标识，随这条打卡保存在服务端。</li>
            <li>不做：不后台追踪，不连续定位，不用于广告。</li>
            <li>你可以：不同意也能打卡（记为普通反馈）；在「我的」导出或注销时一并导出或删除这些记录；随时在隐私说明页撤回本机的定位同意。</li>
          </ul>
          <p className="text-meta text-muted">
            详见{' '}
            <a className="underline" href="/privacy" target="_blank" rel="noreferrer">
              隐私说明（草案）
            </a>
            。
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="soft" onClick={onDecline}>
              暂不同意
            </Button>
            <Button variant="dark" onClick={onAgree}>
              同意并定位
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
