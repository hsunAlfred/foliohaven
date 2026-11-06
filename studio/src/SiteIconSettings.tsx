import type { AriaAttributes } from 'react';
import { SiteIconsSchema } from '@foliohaven/core';
import type { SiteConfig } from '@foliohaven/core';
import type { StudioApi } from './api.js';
import { Field, TextField } from './components.js';
import { ImageSelect } from './ImageSelect.js';
import './site-icon-settings.css';

type SiteIcons = SiteConfig['icons'];
const defaults = SiteIconsSchema.parse({});

function ColorControl({
  id,
  label,
  value,
  fallback,
  disabled,
  onChange,
  'data-field': field,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
}: {
  id?: string;
  label: string;
  value: string;
  fallback: string;
  disabled: boolean;
  onChange: (value: string) => void;
  'data-field': string;
} & Pick<AriaAttributes, 'aria-describedby' | 'aria-invalid'>) {
  return (
    <div className="site-icon-color-input">
      <input
        type="color"
        aria-label={`${label}色票`}
        value={/^#[0-9a-f]{6}$/iu.test(value) ? value : fallback}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <input
        id={id}
        type="text"
        value={value}
        maxLength={7}
        autoComplete="off"
        spellCheck={false}
        data-field={field}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function IconColorField({
  label,
  name,
  value,
  disabled,
  onChange,
}: {
  label: string;
  name: 'maskColor' | 'themeLight' | 'themeDark' | 'backgroundColor';
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} width="medium" hint="可使用色票或輸入六位 HEX 色碼。">
      <ColorControl
        label={label}
        data-field={`icons.${name}`}
        value={value}
        fallback={defaults[name]}
        disabled={disabled}
        onChange={onChange}
      />
    </Field>
  );
}

export function SiteIconSettings({
  api,
  favicon,
  value,
  disabled,
  onFaviconChange,
  onChange,
}: {
  api: StudioApi;
  favicon: SiteConfig['favicon'];
  value: SiteIcons | undefined;
  disabled: boolean;
  onFaviconChange: (value: SiteConfig['favicon']) => void;
  onChange: (value: SiteIcons) => void;
}) {
  const icons = value ?? defaults;
  const update = (partial: Partial<SiteIcons>) =>
    onChange({ ...icons, ...partial });
  const inactive = disabled || !icons.enabled;
  const appInactive = inactive || !icons.manifest;
  return (
    <fieldset className="site-icon-settings" disabled={disabled}>
      <legend>網站圖示</legend>
      <p className="muted">
        選擇主圖，統一設定瀏覽器、加入主畫面與 App 使用的圖示。
      </p>
      <ImageSelect
        api={api}
        label="主圖（Favicon）"
        field="favicon"
        value={favicon}
        onChange={onFaviconChange}
        imagesOnly
        preference="favicon"
        emptyLabel="使用瀏覽器預設圖示"
        hint="建議使用 SVG 或至少 512px 的方形圖片；留空時不指定 favicon。保存後更新網站才會套用。"
        disabled={disabled}
      />
      <label className="check">
        <input
          type="checkbox"
          data-field="icons.enabled"
          checked={icons.enabled}
          onChange={(event) => update({ enabled: event.target.checked })}
        />
        產生多尺寸圖示
      </label>
      <p className="muted site-icon-settings__hint">
        啟用後從主圖產生不同尺寸，並提供下方的 Apple、Manifest、Safari
        與瀏覽器色彩設定。
      </p>
      <fieldset
        disabled={!icons.enabled}
        className="site-icon-settings__options"
      >
        <legend className="sr-only">延伸圖示與瀏覽器設定</legend>
        <div className="site-icon-output-options">
          <label className="check">
            <input
              type="checkbox"
              data-field="icons.appleTouch"
              checked={icons.appleTouch}
              onChange={(event) => update({ appleTouch: event.target.checked })}
            />
            Apple Touch 圖示
          </label>
          <label className="check">
            <input
              type="checkbox"
              data-field="icons.manifest"
              checked={icons.manifest}
              onChange={(event) => update({ manifest: event.target.checked })}
            />
            Web App Manifest
          </label>
        </div>
        <ImageSelect
          api={api}
          label="Safari pinned tab 圖示"
          field="icons.maskIcon"
          value={icons.maskIcon}
          onChange={(maskIcon) => update({ maskIcon })}
          imagesOnly
          preference="mask"
          emptyLabel="自動使用 SVG 網站圖示"
          hint="可另選 SVG；留空時自動使用上方的 SVG 網站圖示。主圖為 PNG 或 ICO 時不產生 Safari 圖示。"
          disabled={inactive}
        />
        <IconColorField
          label="Safari 圖示色彩"
          name="maskColor"
          value={icons.maskColor}
          disabled={inactive}
          onChange={(maskColor) => update({ maskColor })}
        />
        <div className="settings-field-grid">
          <IconColorField
            label="淺色模式瀏覽器色彩"
            name="themeLight"
            value={icons.themeLight}
            disabled={inactive}
            onChange={(themeLight) => update({ themeLight })}
          />
          <IconColorField
            label="深色模式瀏覽器色彩"
            name="themeDark"
            value={icons.themeDark}
            disabled={inactive}
            onChange={(themeDark) => update({ themeDark })}
          />
        </div>
        <div className="settings-field-grid">
          <TextField
            label="App 名稱"
            field="icons.appName"
            value={icons.appName}
            nullable
            maxLength={120}
            hint="留空時使用網站名稱。"
            disabled={appInactive}
            onChange={(appName) => update({ appName })}
          />
          <TextField
            label="App 短名稱"
            field="icons.shortName"
            value={icons.shortName}
            nullable
            maxLength={40}
            hint="留空時使用網站名稱。"
            disabled={appInactive}
            onChange={(shortName) => update({ shortName })}
          />
          <Field label="App 顯示模式" width="medium">
            <select
              data-field="icons.display"
              value={icons.display}
              disabled={appInactive}
              onChange={(event) =>
                update({ display: event.target.value as SiteIcons['display'] })
              }
            >
              <option value="standalone">獨立視窗</option>
              <option value="minimal-ui">精簡瀏覽器介面</option>
              <option value="browser">一般瀏覽器</option>
            </select>
          </Field>
          <IconColorField
            label="啟動畫面背景色"
            name="backgroundColor"
            value={icons.backgroundColor}
            disabled={appInactive}
            onChange={(backgroundColor) => update({ backgroundColor })}
          />
        </div>
      </fieldset>
    </fieldset>
  );
}
