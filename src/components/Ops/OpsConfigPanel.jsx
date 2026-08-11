import React, { useEffect, useRef, useState } from 'react';
import { Database, Plus, RotateCcw, Save, Shield, Ticket, Trash2 } from 'lucide-react';
import { getAdminToken, getCmsConfig, getProducts, saveCmsConfig, saveProducts, setAdminToken } from '../../lib/api';
import { ResourceNotice, formatApiError, useOpsResource } from './OpsShared';

const EMPTY_CMS = { defaultCity: '', heroTitle: '', featuredCities: [], announcements: [] };

export default function OpsConfigPanel({ onTokenChanged }) {
  const cmsResource = useOpsResource((signal) => getCmsConfig(signal));
  const productsResource = useOpsResource((signal) => getProducts(signal));
  const [adminTokenDraft, setAdminTokenDraft] = useState(() => getAdminToken());
  const [cmsConfig, setCmsConfig] = useState(EMPTY_CMS);
  const [productConfig, setProductConfig] = useState([]);
  const [messages, setMessages] = useState({ token: '', cms: '', products: '' });
  const [saving, setSaving] = useState({ cms: false, products: false });
  const dirtyRef = useRef({ cms: false, products: false });
  const [dirty, setDirty] = useState({ cms: false, products: false });

  function setDirtyFlag(key, value) {
    dirtyRef.current = { ...dirtyRef.current, [key]: value };
    setDirty(dirtyRef.current);
  }

  useEffect(() => {
    // 拉取刷新不覆盖未保存的编辑，避免运营手滑丢内容。
    if (cmsResource.data?.config && !dirtyRef.current.cms) setCmsConfig(cmsResource.data.config);
  }, [cmsResource.data]);

  useEffect(() => {
    if (Array.isArray(productsResource.data?.products) && !dirtyRef.current.products) setProductConfig(productsResource.data.products);
  }, [productsResource.data]);

  function changeCms(updater) {
    setDirtyFlag('cms', true);
    setCmsConfig(updater);
  }

  function changeProducts(updater) {
    setDirtyFlag('products', true);
    setProductConfig(updater);
  }

  function discardCms() {
    setCmsConfig(cmsResource.data?.config ?? EMPTY_CMS);
    setDirtyFlag('cms', false);
    setMessages((previous) => ({ ...previous, cms: '已放弃未保存的 CMS 修改。' }));
  }

  function discardProducts() {
    setProductConfig(Array.isArray(productsResource.data?.products) ? productsResource.data.products : []);
    setDirtyFlag('products', false);
    setMessages((previous) => ({ ...previous, products: '已放弃未保存的商品卡修改。' }));
  }

  function saveToken() {
    const next = setAdminToken(adminTokenDraft);
    setMessages((previous) => ({ ...previous, token: next ? '管理员令牌已保存到当前浏览器会话。' : '管理员令牌已清空。' }));
    cmsResource.retry();
    productsResource.retry();
    onTokenChanged?.();
  }

  async function handleSaveCms(event) {
    event.preventDefault();
    setSaving((previous) => ({ ...previous, cms: true }));
    setMessages((previous) => ({ ...previous, cms: '保存中...' }));
    try {
      const data = await saveCmsConfig(cmsConfig);
      setCmsConfig(data.config);
      setDirtyFlag('cms', false);
      cmsResource.replaceData(data);
      setMessages((previous) => ({ ...previous, cms: '首页 CMS 已保存。' }));
    } catch (error) {
      setMessages((previous) => ({ ...previous, cms: `保存失败：${formatApiError(error)}` }));
    } finally {
      setSaving((previous) => ({ ...previous, cms: false }));
    }
  }

  function updateProduct(index, field, value) {
    changeProducts((previous) => previous.map((item, currentIndex) => currentIndex === index ? { ...item, [field]: value } : item));
  }

  function addProduct() {
    changeProducts((previous) => [{
      type: '本地玩乐',
      title: '新商品卡',
      poi: cmsConfig.defaultCity || '杭州',
      city: cmsConfig.defaultCity || '',
      price: '查看详情',
      provider: '运营配置',
      url: 'https://ditu.amap.com/',
      status: 'active',
      priority: 50,
      sourceAuthorization: 'affiliate-link'
    }, ...previous]);
  }

  async function handleSaveProducts() {
    setSaving((previous) => ({ ...previous, products: true }));
    setMessages((previous) => ({ ...previous, products: '保存中...' }));
    try {
      const data = await saveProducts(productConfig);
      setProductConfig(data.products ?? []);
      setDirtyFlag('products', false);
      productsResource.replaceData(data);
      setMessages((previous) => ({ ...previous, products: `已保存 ${data.products?.length ?? 0} 张商品卡。` }));
    } catch (error) {
      setMessages((previous) => ({ ...previous, products: `保存失败：${formatApiError(error)}` }));
    } finally {
      setSaving((previous) => ({ ...previous, products: false }));
    }
  }

  return (
    <div className="ops-workspace-stack">
      <section className="ops-panel" aria-labelledby="ops-access-title">
        <div className="ops-panel-head">
          <div>
            <h2 id="ops-access-title">管理访问</h2>
            <p className="text-caption">令牌只保存在当前浏览器会话</p>
          </div>
          <span className="badge badge-blue"><Shield size={12} /> session</span>
        </div>
        <div className="ops-token-row">
          <label>
            <span className="input-label">管理员令牌</span>
            <input className="input-field" type="password" autoComplete="off" value={adminTokenDraft} onChange={(event) => setAdminTokenDraft(event.target.value)} placeholder="x-routebook-admin-token" />
          </label>
          <button className="btn btn-secondary" type="button" onClick={saveToken}>应用令牌</button>
        </div>
        <p className="text-caption" role="status" aria-live="polite">{messages.token}</p>
      </section>

      <section className="ops-panel" aria-labelledby="ops-cms-title">
        <div className="ops-panel-head">
          <div>
            <h2 id="ops-cms-title">首页 CMS</h2>
            <p className="text-caption">首页城市、标题和公告</p>
          </div>
          <span className="badge badge-blue"><Database size={12} /> 配置</span>
        </div>
        <ResourceNotice resource={cmsResource} label="CMS 配置" />
        {cmsResource.data && (
          <form className="cms-form ops-config-form" onSubmit={handleSaveCms}>
            <div className="ops-config-grid">
              <label>
                <span className="input-label">首页默认城市</span>
                <input className="input-field" value={cmsConfig.defaultCity ?? ''} onChange={(event) => changeCms((previous) => ({ ...previous, defaultCity: event.target.value }))} />
              </label>
              <label>
                <span className="input-label">Hero 标题</span>
                <input className="input-field" value={cmsConfig.heroTitle ?? ''} onChange={(event) => changeCms((previous) => ({ ...previous, heroTitle: event.target.value }))} />
              </label>
              <label>
                <span className="input-label">推荐城市</span>
                <input className="input-field" value={(cmsConfig.featuredCities ?? []).join('、')} onChange={(event) => changeCms((previous) => ({ ...previous, featuredCities: event.target.value.split(/[、,\s]+/).filter(Boolean) }))} />
              </label>
              <label>
                <span className="input-label">运营公告</span>
                <textarea className="input-field" value={(cmsConfig.announcements ?? []).join('\n')} onChange={(event) => changeCms((previous) => ({ ...previous, announcements: event.target.value.split(/\n+/).filter(Boolean) }))} />
              </label>
            </div>
            <div className="ops-inline-actions">
              <button className="btn btn-primary btn-sm" type="submit" disabled={saving.cms}><Save size={14} /> {saving.cms ? '保存中...' : '保存 CMS'}</button>
              {dirty.cms && (
                <>
                  <span className="badge badge-orange">有未保存修改</span>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={discardCms} disabled={saving.cms}><RotateCcw size={13} /> 放弃修改</button>
                </>
              )}
            </div>
            <p className={`text-caption ${messages.cms.startsWith('保存失败') ? 'ops-error-text' : ''}`} role="status" aria-live="polite">{messages.cms}</p>
          </form>
        )}
      </section>

      <section className="ops-panel" aria-labelledby="ops-products-title">
        <div className="ops-panel-head">
          <div>
            <h2 id="ops-products-title">商品卡配置</h2>
            <p className="text-caption">关联 POI、供应商和外部入口</p>
          </div>
          <span className="badge badge-blue"><Ticket size={12} /> {productsResource.data ? `${productConfig.length} 张` : '—'}</span>
        </div>
        <ResourceNotice resource={productsResource} label="商品配置" />
        {productsResource.data && (
          <>
            <div className="product-config-list">
              {productConfig.map((item, index) => (
                <div key={`${item.id || item.title}-${index}`} className="product-config-row">
                  <div className="product-config-grid">
                    <label><span className="input-label">商品标题</span><input className="input-field" value={item.title ?? ''} onChange={(event) => updateProduct(index, 'title', event.target.value)} /></label>
                    <label><span className="input-label">关联 POI</span><input className="input-field" value={item.poi ?? ''} onChange={(event) => updateProduct(index, 'poi', event.target.value)} /></label>
                    <label><span className="input-label">城市</span><input className="input-field" value={item.city ?? ''} onChange={(event) => updateProduct(index, 'city', event.target.value)} /></label>
                    <label><span className="input-label">供应商</span><input className="input-field" value={item.provider ?? ''} onChange={(event) => updateProduct(index, 'provider', event.target.value)} /></label>
                    <label><span className="input-label">类型</span><input className="input-field" value={item.type ?? ''} onChange={(event) => updateProduct(index, 'type', event.target.value)} /></label>
                    <label><span className="input-label">价格文案</span><input className="input-field" value={item.price ?? ''} onChange={(event) => updateProduct(index, 'price', event.target.value)} /></label>
                    <label><span className="input-label">状态</span><select className="input-field" value={item.status ?? 'active'} onChange={(event) => updateProduct(index, 'status', event.target.value)}><option value="active">启用</option><option value="paused">暂停</option></select></label>
                    <label><span className="input-label">优先级</span><input className="input-field" type="number" min="0" max="1000" value={item.priority ?? 0} onChange={(event) => updateProduct(index, 'priority', Number(event.target.value))} /></label>
                  </div>
                  <label><span className="input-label">外部 URL</span><input className="input-field" type="url" value={item.url ?? ''} onChange={(event) => updateProduct(index, 'url', event.target.value)} /></label>
                  <div className="ops-inline-actions">
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => changeProducts((previous) => previous.filter((_, currentIndex) => currentIndex !== index))}><Trash2 size={13} /> 删除</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="ops-inline-actions ops-config-actions">
              <button className="btn btn-secondary btn-sm" type="button" onClick={addProduct}><Plus size={14} /> 新增商品卡</button>
              <button className="btn btn-primary btn-sm" type="button" onClick={handleSaveProducts} disabled={saving.products}><Save size={14} /> {saving.products ? '保存中...' : '保存商品配置'}</button>
              {dirty.products && (
                <>
                  <span className="badge badge-orange">有未保存修改</span>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={discardProducts} disabled={saving.products}><RotateCcw size={13} /> 放弃修改</button>
                </>
              )}
            </div>
            <p className={`text-caption ${messages.products.startsWith('保存失败') ? 'ops-error-text' : ''}`} role="status" aria-live="polite">{messages.products}</p>
          </>
        )}
      </section>
    </div>
  );
}
