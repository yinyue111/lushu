import { useState } from 'react';
import { Check } from 'lucide-react';
import { Dialog, DialogContent } from '../ui/dialog';
import { Button } from '../ui/button';
import { Field, inputClass } from '../ui/field';

export default function StopEditor({ stop, isNew = false, routebook, onClose, onSave }) {
  const [form, setForm] = useState(() => ({ ...stop }));

  function update(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function submit(event) {
    event.preventDefault();
    if (!String(form.name ?? '').trim()) return;
    onSave({
      ...form,
      name: String(form.name).trim(),
      area: String(form.area || routebook.city).trim(),
      day: form.day || routebook.days?.[0] || 'Day 1'
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={isNew ? '新增站点' : `编辑：${form.name || '未命名站点'}`}
        description={isNew ? '填好名称就能加进当天路线，位置会在保存后自动核对。' : '改名后会重新核对位置，确认前暂停导航。'}
      >
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="站点名称">
              <input className={inputClass} value={form.name} onChange={(e) => update('name', e.target.value)} placeholder="例如：武康路" required />
            </Field>
            <Field label="第几天">
              <select className={inputClass} value={form.day} onChange={(e) => update('day', e.target.value)}>
                {(routebook.days ?? ['Day 1']).map((day) => (
                  <option key={day}>{day}</option>
                ))}
              </select>
            </Field>
            <Field label="几点到">
              <input className={inputClass} value={form.time} onChange={(e) => update('time', e.target.value)} placeholder="14:00" />
            </Field>
            <Field label="区域">
              <input className={inputClass} value={form.area} onChange={(e) => update('area', e.target.value)} placeholder={`${routebook.city}核心区`} />
            </Field>
            <Field label="停留多久">
              <input className={inputClass} value={form.stay} onChange={(e) => update('stay', e.target.value)} />
            </Field>
            <Field label="大概花费">
              <input className={inputClass} value={form.cost} onChange={(e) => update('cost', e.target.value)} />
            </Field>
            <Field label="纬度" hint="不确定可以不改">
              <input className={inputClass} inputMode="decimal" value={form.lat} onChange={(e) => update('lat', e.target.value)} />
            </Field>
            <Field label="经度">
              <input className={inputClass} inputMode="decimal" value={form.lng} onChange={(e) => update('lng', e.target.value)} />
            </Field>
          </div>
          <Field label="推荐理由">
            <textarea className={`${inputClass} min-h-20`} value={form.verify} onChange={(e) => update('verify', e.target.value)} />
          </Field>
          <Field label="注意事项">
            <textarea className={`${inputClass} min-h-20`} value={form.risk} onChange={(e) => update('risk', e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="soft" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" variant="primary">
              <Check /> {isNew ? '添加站点' : '保存'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
