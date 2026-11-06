import { useLayoutEffect, useRef, useState } from 'react';
import { Dialog } from './Dialog.js';
import { Icon } from './Icon.js';
import type { IconName } from './Icon.js';

const devices = {
  desktop: { label: '桌機', width: 1200, height: 800, icon: 'monitor' },
  tablet: { label: '平板', width: 768, height: 1024, icon: 'tablet' },
  mobile: { label: '手機', width: 390, height: 844, icon: 'smartphone' },
} satisfies Record<
  string,
  { label: string; width: number; height: number; icon: IconName }
>;
type Device = keyof typeof devices;
type Zoom = 'fit' | '50' | '75' | '100';

function PreviewCanvas({
  documentUrl,
  placeholder,
  layoutKey,
  device,
  zoom,
  expanded = false,
}: {
  documentUrl: string | null;
  placeholder: string;
  layoutKey: string;
  device: Device;
  zoom: Zoom;
  expanded?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  // Opening a previously hidden editor tab must fit before the first paint.
  // ResizeObserver handles independent container resizes without resubscribing.
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const style = getComputedStyle(element);
    // Match ResizeObserver's content box before the first visible frame.
    setAvailableWidth(
      Math.max(
        0,
        element.getBoundingClientRect().width -
          parseFloat(style.borderLeftWidth) -
          parseFloat(style.borderRightWidth) -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight),
      ),
    );
  }, [layoutKey]);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailableWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const profile = devices[device];
  const scale =
    zoom === 'fit'
      ? Math.min(1, (availableWidth || profile.width) / profile.width)
      : Number(zoom) / 100;
  return (
    <>
      <div
        className="preview-stage"
        ref={host}
        data-device={device}
        data-viewport-width={profile.width}
        data-scale={scale}
      >
        <div
          className="preview-sheet"
          style={{
            width: profile.width * scale,
            height: profile.height * scale,
          }}
        >
          {documentUrl ? (
            // 每版預覽使用新框架，避免更新網址增加瀏覽器返回歷史。
            <iframe
              key={documentUrl}
              title={expanded ? '放大文章預覽' : '文章即時預覽'}
              src={documentUrl}
              sandbox=""
              referrerPolicy="no-referrer"
              style={{
                width: profile.width,
                height: profile.height,
                transform: `scale(${scale})`,
              }}
            />
          ) : (
            <p className="preview-placeholder" role="status">
              {placeholder}
            </p>
          )}
        </div>
      </div>
      <p className="preview-caption" role="status">
        {profile.label} · {profile.width} × {profile.height} ·{' '}
        {Math.round(scale * 100)}%
        {zoom !== 'fit' && profile.width * scale > availableWidth
          ? ' · 可在預覽區左右捲動'
          : ''}
      </p>
    </>
  );
}

export function PreviewViewport({
  documentUrl,
  placeholder,
  layoutKey,
}: {
  documentUrl: string | null;
  placeholder: string;
  layoutKey: string;
}) {
  const [device, setDevice] = useState<Device>(() =>
    window.innerWidth < 600
      ? 'mobile'
      : window.innerWidth < 1280
        ? 'tablet'
        : 'desktop',
  );
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [expanded, setExpanded] = useState(false);
  const controls = (large: boolean) => (
    <div className="preview-toolbar">
      <div
        className="preview-device-controls"
        role="group"
        aria-label={large ? '放大預覽模擬裝置' : '預覽模擬裝置'}
      >
        {(Object.keys(devices) as Device[]).map((key) => (
          <button
            type="button"
            key={key}
            aria-pressed={device === key}
            onClick={() => setDevice(key)}
          >
            <Icon name={devices[key].icon} size={17} />
            {devices[key].label}
          </button>
        ))}
      </div>
      <label className="preview-zoom">
        <span>縮放</span>
        <select
          aria-label={large ? '放大預覽縮放' : '預覽縮放'}
          value={zoom}
          onChange={(event) => setZoom(event.target.value as Zoom)}
        >
          <option value="fit">符合區域</option>
          <option value="50">50%</option>
          <option value="75">75%</option>
          <option value="100">100%</option>
        </select>
      </label>
      {!large && (
        <button
          className="quiet"
          type="button"
          onClick={() => setExpanded(true)}
        >
          <Icon name="zoomIn" size={17} />
          放大預覽
        </button>
      )}
    </div>
  );
  return (
    <>
      {controls(false)}
      <PreviewCanvas
        documentUrl={documentUrl}
        placeholder={placeholder}
        layoutKey={layoutKey}
        device={device}
        zoom={zoom}
      />
      {expanded && (
        <Dialog
          open
          title="放大預覽"
          className="preview-dialog"
          onClose={() => setExpanded(false)}
        >
          {controls(true)}
          <PreviewCanvas
            documentUrl={documentUrl}
            placeholder={placeholder}
            layoutKey={layoutKey}
            device={device}
            zoom={zoom}
            expanded
          />
        </Dialog>
      )}
    </>
  );
}
