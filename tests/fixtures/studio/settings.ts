import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export const settingsSections = {
  general: '網站與作者',
  navigation: '導覽',
  seo: 'SEO 與社群分享',
  home: '首頁與列表',
  rss: 'RSS',
} as const;
export type SettingsSection = keyof typeof settingsSections;

export async function chooseSettingsSection(
  page: Page,
  section: SettingsSection,
) {
  const select = page.getByLabel('設定區塊', { exact: true });
  if (await select.isVisible()) await select.selectOption(section);
  else
    await page
      .getByRole('tablist', { name: '全站設定區塊', exact: true })
      .getByRole('tab', { name: settingsSections[section], exact: true })
      .click();
  const panel = page.getByRole('tabpanel', {
    name: settingsSections[section],
    exact: true,
  });
  await expect(panel).toBeVisible();
  await expect(page.locator('.settings-section-panel:visible')).toHaveCount(1);
  return panel;
}
