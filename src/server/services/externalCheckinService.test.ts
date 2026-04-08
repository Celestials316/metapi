import { describe, expect, it } from 'vitest';
import {
  classifyExternalCheckinKindFromHtml,
  extractExternalCheckinSuccessSummary,
  normalizeExternalCheckinKind,
  normalizeOptionalExternalCheckinUrlInput,
  resolveStoredAccountCheckinActionMode,
} from './externalCheckinService.js';

describe('externalCheckinService', () => {
  it('normalizes supported external checkin kinds', () => {
    expect(normalizeExternalCheckinKind('token_bridge')).toBe('token_bridge');
    expect(normalizeExternalCheckinKind(' aisign ')).toBe('aisign');
    expect(normalizeExternalCheckinKind(' manual_oauth ')).toBe('manual_oauth');
    expect(normalizeExternalCheckinKind('unsupported')).toBe('unsupported');
    expect(normalizeExternalCheckinKind('unknown')).toBeNull();
  });

  it('strips runtime-only query params from external checkin urls', () => {
    expect(normalizeOptionalExternalCheckinUrlInput(
      'https://sign.example.com/embed/?token=abc&user_id=11&src_host=https%3A%2F%2Fdemo.example.com&src_url=https%3A%2F%2Fdemo.example.com&lang=zh-CN&ui_mode=dark&foo=bar',
    )).toEqual({
      valid: true,
      present: true,
      url: 'https://sign.example.com/embed?foo=bar',
    });
  });

  it('rejects invalid protocols', () => {
    expect(normalizeOptionalExternalCheckinUrlInput('ftp://sign.example.com')).toEqual({
      valid: false,
      present: true,
      url: null,
    });
  });

  it('classifies embedded manual oauth prompt pages as manual jump capable', () => {
    const html = `
      <!doctype html>
      <html lang="zh-CN">
      <body>
        <main class="page">
          <section class="login-screen">
            <div class="login-card">
              <p class="login-kicker">欢迎登录</p>
              <h1 class="login-title">52公益站<br/>签到系统</h1>
              <span class="primary-button login-button login-button-disabled">请点击右上角在新窗口打开</span>
            </div>
          </section>
        </main>
      </body>
      </html>
    `;

    expect(classifyExternalCheckinKindFromHtml(html)).toBe('manual_oauth');
  });

  it('classifies token bridge pages from embedded checkin centers', () => {
    const html = `
      <!doctype html>
      <html lang="zh-CN">
      <body>
        <div class="card">
          <div class="title">签到中心</div>
        </div>
        <div class="card">
          <span class="badge badge-warn">今日未签到</span>
          <div class="kpi"><div class="v">139.08</div><div class="l">当前余额（刀）</div></div>
          <div class="kpi"><div class="v">6318</div><div class="l">账户ID</div></div>
          <form action="/checkin?next=/embed" method="post">
            <button type="submit">立即签到</button>
          </form>
        </div>
      </body>
      </html>
    `;

    expect(classifyExternalCheckinKindFromHtml(html)).toBe('token_bridge');
  });

  it('extracts explicit reward summaries from ice token-bridge success pages', () => {
    const html = `
      <div class="notice ok">签到成功：获得 40 刀</div>
      <div class="card">
        <span class="badge badge-ok">今日已签到</span>
      </div>
    `;

    expect(extractExternalCheckinSuccessSummary(html)).toEqual({
      message: '签到成功：获得 40 刀',
      reward: '40',
    });
  });

  it('extracts balance-plus rewards from banner style success pages', () => {
    const html = `
      <div class="banner banner-success">签到成功，余额 &#43;54.69</div>
      <section class="hero hero-logged">
        <span class="balance-status">刚刚同步</span>
      </section>
    `;

    expect(extractExternalCheckinSuccessSummary(html)).toEqual({
      message: '签到成功，余额 +54.69',
      reward: '54.69',
    });
  });

  it('resolves stored checkin action modes without runtime probing', () => {
    expect(resolveStoredAccountCheckinActionMode(
      { accessToken: 'session-token' } as any,
      { platform: 'new-api', externalCheckinUrl: null, externalCheckinKind: null } as any,
    )).toBe('auto');

    expect(resolveStoredAccountCheckinActionMode(
      { accessToken: 'session-token' } as any,
      {
        platform: 'sub2api',
        externalCheckinUrl: 'https://sign.example.com/embed',
        externalCheckinKind: 'manual_oauth',
      } as any,
    )).toBe('manual_jump');

    expect(resolveStoredAccountCheckinActionMode(
      { accessToken: 'session-token' } as any,
      {
        platform: 'sub2api',
        externalCheckinUrl: 'https://sign.example.com/embed',
        externalCheckinKind: null,
      } as any,
    )).toBe('manual_jump');

    expect(resolveStoredAccountCheckinActionMode(
      { accessToken: 'session-token' } as any,
      {
        platform: 'sub2api',
        externalCheckinUrl: 'https://aisign.td.ee/app',
        externalCheckinKind: 'aisign',
      } as any,
    )).toBe('auto');

    expect(resolveStoredAccountCheckinActionMode(
      { accessToken: 'session-token' } as any,
      {
        platform: 'sub2api',
        externalCheckinUrl: 'https://aisign.td.ee/app',
        externalCheckinKind: null,
      } as any,
    )).toBe('auto');

    expect(resolveStoredAccountCheckinActionMode(
      { accessToken: '' } as any,
      {
        platform: 'sub2api',
        externalCheckinUrl: 'https://sign.example.com/embed',
        externalCheckinKind: 'token_bridge',
      } as any,
    )).toBe('none');
  });
});
