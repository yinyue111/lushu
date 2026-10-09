import { useState } from 'react';
import { Filter, RefreshCw, ShieldAlert } from 'lucide-react';
import { CheckinPhoto } from '../visual/CheckinPhoto';
import { getOpsCheckins } from '../../lib/opsApi';
import OpsAuditDialog from './OpsAuditDialog';
import { EmptyState, ResourceNotice, firstValue, formatOpsDate, hasValue, textValue, useOpsResource } from './OpsShared';

// 与 server/config/index.mjs CHECKIN_MAX_REPORTED_ACCURACY_METERS 默认值保持一致；
// 仅用于列表侧的异常提示，不参与服务端判定。
const ACCURACY_LIMIT_METERS = 500;

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'weak', label: '弱定位' },
  { id: 'invalid', label: '无效到达' },
  { id: 'correction', label: '纠偏样本' },
  { id: 'skipped', label: '跳过/替换' },
  { id: 'excluded', label: '已排除/商业激励' }
];

// 处置由追加审计驱动，保留原始打卡并实时投影至可信度与公开回顾。
export default function CheckinAuditPanel() {
  const checkinsResource = useOpsResource((signal) => getOpsCheckins(200, signal));
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(null);
  const rows = normalizeCheckins(checkinsResource.data);
  const visibleRows = rows.filter((row) => matchesFilter(row, filter));
  const listReady = checkinsResource.status === 'ready' || checkinsResource.status === 'empty' || checkinsResource.status === 'refreshing';

  return (
    <div className="ops-workspace-stack">
      <section className="ops-panel" aria-labelledby="checkin-audit-title">
        <div className="ops-panel-head">
          <div>
            <h2 id="checkin-audit-title">打卡审核与可信样本处置</h2>
            <p className="text-caption">核对定位与照片；排除、恢复及商业激励标记均需填写原因并保留审计</p>
          </div>
          <span className="badge badge-orange">
            <ShieldAlert size={12} /> {checkinsResource.data ? `${visibleRows.length} 条` : '—'}
          </span>
        </div>
        <div className="ops-filter-bar" aria-label="打卡筛选">
          <Filter size={15} aria-hidden="true" />
          <label>
            <span>风控筛选</span>
            <select className="input-field" value={filter} onChange={(event) => setFilter(event.target.value)}>
              {FILTERS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-secondary btn-sm" type="button" onClick={checkinsResource.retry} disabled={checkinsResource.status === 'loading'}>
            <RefreshCw size={13} /> 刷新
          </button>
        </div>
        <ResourceNotice resource={checkinsResource} label="打卡记录" />
        {visibleRows.length ? (
          <div className="ops-table-scroll" tabIndex={0} role="region" aria-label="可横向滚动的数据表">
            <table className="ops-data-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>路线 / 站点</th>
                  <th>身份</th>
                  <th>到达置信</th>
                  <th>距离 / 误差</th>
                  <th>照片</th>
                  <th>运营处置</th>
                  <th>状态</th>
                  <th>值得</th>
                  <th>异常原因</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row, index) => (
                  <tr
                    key={row.id || `${row.profileId}-${row.createdAt}-${index}`}
                    style={row.anomalies.length ? { background: 'rgba(220, 68, 68, 0.06)' } : undefined}
                  >
                    <td>{formatOpsDate(row.createdAt)}</td>
                    <td>
                      <strong>{textValue(firstValue(row.routeTitle, row.routeId))}</strong>
                      <small>
                        {textValue(firstValue(row.stopName, row.stopId))}
                        {row.city ? ` · ${row.city}` : ''}
                      </small>
                    </td>
                    <td>
                      <TrustStateBadge value={row.trustState} />
                      <small>{shortProfileId(row.profileId)}</small>
                    </td>
                    <td>
                      <ConfidenceBadge confidence={row.confidence} valid={row.arrivalValid} />
                    </td>
                    <td>
                      {hasValue(row.distanceMeters) ? `${Math.round(Number(row.distanceMeters))}m` : '—'}
                      <small>
                        误差 {hasValue(row.accuracy) ? `${Math.round(Number(row.accuracy))}m` : '—'}
                        {hasValue(row.thresholdMeters) ? ` / 阈值 ${Math.round(Number(row.thresholdMeters))}m` : ''}
                      </small>
                    </td>
                    <td>
                      {row.photoId ? <CheckinPhoto photoId={row.photoId} access="admin" alt={`${row.stopName || '打卡'}照片`} className="size-11" /> : '—'}
                    </td>
                    <td>
                      <span className={`badge ${row.opsDisposition?.excluded || row.opsDisposition?.commercialIncentive ? 'badge-orange' : 'badge-blue'}`}>
                        {row.opsDisposition?.excluded ? '已排除' : row.opsDisposition?.commercialIncentive ? '商业激励' : '未处置'}
                      </span>
                      <button type="button" className="btn btn-secondary btn-sm mt-2" onClick={() => setSelected(row)}>
                        处置 / 历史
                      </button>
                    </td>
                    <td>
                      <StatusBadge value={row.status} />
                    </td>
                    <td>{textValue(row.worth)}</td>
                    <td>
                      {row.anomalies.length ? (
                        row.anomalies.map((reason) => (
                          <span key={reason} className="badge badge-red" style={{ marginRight: 4 }}>
                            {reason}
                          </span>
                        ))
                      ) : (
                        <span className="badge badge-green">正常</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : listReady ? (
          <EmptyState>{filter === 'all' ? '暂无打卡记录。' : '当前筛选条件下没有打卡记录。'}</EmptyState>
        ) : null}
        <p className="text-caption" style={{ marginTop: 10 }}>
          异常判定：到达无效、上报定位误差超过 {ACCURACY_LIMIT_METERS}m、照片与 GPS
          不一致（photoEvidence=gps-mismatch）或移动速度异常。部分字段（照片证据、纠偏标记）随服务端本波落库后才会出现。
        </p>
      </section>
      {selected && (
        <OpsAuditDialog
          key={selected.id}
          entity={{
            type: 'checkin',
            id: selected.id,
            title: `${selected.routeTitle || '路书'} · ${selected.stopName || '打卡'}`,
            disposition: selected.opsDisposition,
            history: selected.opsAuditHistory
          }}
          onClose={() => setSelected(null)}
          onSaved={checkinsResource.retry}
        />
      )}
    </div>
  );
}

function normalizeCheckins(data) {
  const rows = Array.isArray(data?.checkins) ? data.checkins : [];
  return rows.map((item) => {
    const arrival = item?.arrival && typeof item.arrival === 'object' ? item.arrival : null;
    const confidence = String(firstValue(arrival?.confidence, item?.arrivalConfidence) ?? '').toLowerCase();
    const accuracy = firstValue(arrival?.accuracy, item?.gps?.accuracy);
    const photoEvidence = String(firstValue(item?.photoEvidence, arrival?.photoEvidence) ?? '');
    const usedCoordinateCorrection = arrival?.usedCoordinateCorrection === true || item?.usedCoordinateCorrection === true;
    return {
      id: item?.id,
      createdAt: item?.createdAt,
      routeId: item?.routeId,
      routeTitle: item?.routeTitle,
      city: item?.city,
      stopId: item?.stopId,
      stopName: item?.stopName,
      profileId: item?.profileId,
      trustState: item?.trustState,
      status: item?.status,
      worth: item?.worth,
      opsDisposition: item?.opsDisposition,
      opsAuditHistory: item?.opsAuditHistory,
      photoId: String(item?.photoId ?? '').trim(),
      arrival,
      arrivalValid: arrival?.valid,
      confidence,
      accuracy,
      distanceMeters: arrival?.distanceMeters,
      thresholdMeters: arrival?.thresholdMeters,
      fraudSignal: String(firstValue(arrival?.fraudSignal, item?.fraudSignal) ?? ''),
      photoEvidence,
      usedCoordinateCorrection,
      anomalies: buildAnomalies(arrival, accuracy, photoEvidence, firstValue(arrival?.fraudSignal, item?.fraudSignal))
    };
  });
}

function buildAnomalies(arrival, accuracy, photoEvidence, fraudSignal) {
  const reasons = [];
  if (arrival && arrival.valid === false) reasons.push(textValue(arrival.label) !== '—' ? `到达无效：${arrival.label}` : '到达无效');
  if (hasValue(accuracy) && Number.isFinite(Number(accuracy)) && Number(accuracy) > ACCURACY_LIMIT_METERS) reasons.push('定位误差超限');
  if (photoEvidence === 'gps-mismatch') reasons.push('照片与 GPS 不一致');
  if (String(fraudSignal ?? '') === 'implausible-speed' && !reasons.some((reason) => reason.includes('速度'))) reasons.push('移动速度异常');
  return reasons;
}

function matchesFilter(row, filter) {
  if (filter === 'weak') return ['weak', 'unverified'].includes(row.confidence);
  if (filter === 'invalid') return row.arrivalValid === false;
  if (filter === 'correction') return row.usedCoordinateCorrection;
  if (filter === 'skipped') return ['skipped', 'replaced'].includes(String(row.status ?? ''));
  if (filter === 'excluded') return row.opsDisposition?.excluded || row.opsDisposition?.commercialIncentive;
  return true;
}

function shortProfileId(profileId) {
  const id = String(profileId ?? '').trim();
  if (!id) return '—';
  if (id === 'anonymous') return '匿名';
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

function TrustStateBadge({ value }) {
  const presentation = {
    'profile-attested': ['身份可信', 'badge-green'],
    'profile-owned': ['身份自持', 'badge-blue'],
    untrusted: ['未验证', 'badge-orange']
  }[String(value ?? '')] ?? ['未知', 'badge-blue'];
  return <span className={`badge ${presentation[1]}`}>{presentation[0]}</span>;
}

function ConfidenceBadge({ confidence, valid }) {
  const presentation = {
    valid: ['有效到达', 'badge-green'],
    weak: ['弱定位', 'badge-orange'],
    invalid: ['疑似偏离', 'badge-red'],
    unverified: ['未验证', 'badge-blue']
  }[confidence] ?? [valid === true ? '有效到达' : '未知', valid === true ? 'badge-green' : 'badge-blue'];
  return <span className={`badge ${presentation[1]}`}>{presentation[0]}</span>;
}

function StatusBadge({ value }) {
  const presentation = {
    visited: ['已到访', 'badge-green'],
    skipped: ['已跳过', 'badge-orange'],
    replaced: ['已替换', 'badge-orange']
  }[String(value ?? '')] ?? ['未知', 'badge-blue'];
  return <span className={`badge ${presentation[1]}`}>{presentation[0]}</span>;
}
