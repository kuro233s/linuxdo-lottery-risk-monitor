// ==UserScript==
// @name         linux.do 抽奖帖风险监控
// @namespace    https://linux.do/
// @version      0.1.0
// @description  持续扫描抽奖帖中的举报/隐藏评论并提示风险
// @match        https://linux.do/*
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function bootstrapUserscript() {
  "use strict";

  const STORAGE_PREFIX = "linuxdo-risk-monitor:";
  const WATCHLIST_KEY = `${STORAGE_PREFIX}watchlist`;
  const WATCHLIST_LIMIT = 20;
  const BANNER_ID = "linuxdo-risk-monitor-banner";
  const STYLE_ID = "linuxdo-risk-monitor-style";
  const TOAST_ID = "linuxdo-risk-monitor-toast";
  const POLL_INTERVAL_MS = 15000;
  const LOTTERY_KEYWORDS = ["抽奖", "开奖", "送码", "送会员", "福利"];
  const FINISH_KEYWORDS = ["已开奖", "开奖结果", "中奖名单", "中奖用户", "已结束", "活动结束"];
  const RISK_TEXT_PATTERNS = ["被社区举报", "临时隐藏", "temporarily hidden", "community flagged"];
  const RISK_SELECTORS = [
    ".post-notice",
    ".hidden-post",
    ".hidden-reply",
    ".expand-hidden",
    ".post-hidden",
    ".hidden-replies-notice",
  ];

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function containsKeyword(text, keywords) {
    const normalized = normalizeText(text);
    return keywords.some((keyword) => normalized.includes(keyword));
  }

  function isLotteryTopic(context) {
    return containsKeyword(context?.title, LOTTERY_KEYWORDS) ||
      containsKeyword(context?.firstPostText, LOTTERY_KEYWORDS);
  }

  function isFinishedTopic(context) {
    return containsKeyword(context?.title, FINISH_KEYWORDS) ||
      containsKeyword(context?.firstPostText, FINISH_KEYWORDS);
  }

  function getPostId(node) {
    return node?.getAttribute("data-post-id") ||
      node?.id?.replace(/^post_/, "") ||
      null;
  }

  function nodeHasRiskSignal(node) {
    if (!node) {
      return false;
    }

    const text = normalizeText(node.textContent);
    if (RISK_TEXT_PATTERNS.some((pattern) => text.includes(pattern))) {
      return true;
    }

    return RISK_SELECTORS.some((selector) => {
      if (node.matches?.(selector)) {
        return true;
      }

      return Boolean(node.querySelector?.(selector));
    });
  }

  function scanRiskyPostIds(document) {
    const posts = Array.from(
      document.querySelectorAll(
        [
          "article.topic-post",
          ".topic-post",
          "article.small-action",
          ".small-action",
          "[data-post-id]",
          '[id^="post_"]',
        ].join(", ")
      )
    );
    const ids = posts
      .filter((post) => nodeHasRiskSignal(post))
      .map((post) => getPostId(post))
      .filter(Boolean);

    return Array.from(new Set(ids)).sort((left, right) => Number(left) - Number(right));
  }

  function mergeRiskyPostIds(currentIds, cachedIds) {
    return Array.from(new Set([...(cachedIds || []), ...(currentIds || [])]))
      .sort((left, right) => Number(left) - Number(right));
  }

  function formatMonitorStatus(stopped, stopReason) {
    if (!stopped) {
      return "监控中";
    }

    return stopReason === "manual" ? "已手动停止" : "已自动停止";
  }

  function buildBannerModel(state) {
    const riskyCount = Number(state?.riskyCount || 0);
    const status = formatMonitorStatus(state?.stopped, state?.stopReason);

    return {
      visible: riskyCount > 0,
      severity: riskyCount > 0 ? "warning" : "idle",
      message: "风险帖子！该抽奖帖曾有过举报记录！请慎重发言！",
      detail: `已记录 ${riskyCount} 条风险评论，最近扫描：${state?.lastScanAt || "未扫描"}，状态：${status}`,
    };
  }

  function getStorageKey(context) {
    return `${STORAGE_PREFIX}${context?.topicId || context?.topicUrl || ""}`;
  }

  function safeParseState(rawValue) {
    if (!rawValue) {
      return null;
    }

    try {
      return JSON.parse(rawValue);
    } catch (error) {
      return null;
    }
  }

  function readState(storage, context) {
    try {
      return safeParseState(storage?.getItem?.(getStorageKey(context)));
    } catch (error) {
      return null;
    }
  }

  function writeState(storage, context, state) {
    try {
      storage?.setItem?.(getStorageKey(context), JSON.stringify(state));
      return true;
    } catch (error) {
      return false;
    }
  }

  function padNumber(value) {
    return String(value).padStart(2, "0");
  }

  function formatTimestamp(date) {
    const value = date instanceof Date ? date : new Date();
    return [
      value.getFullYear(),
      padNumber(value.getMonth() + 1),
      padNumber(value.getDate()),
    ].join("-") + ` ${padNumber(value.getHours())}:${padNumber(value.getMinutes())}:${padNumber(value.getSeconds())}`;
  }

  function extractTopicId(document, locationLike) {
    const attributeValue = document.querySelector("[data-topic-id]")?.getAttribute("data-topic-id");
    if (attributeValue) {
      return attributeValue;
    }

    const pathname = String(locationLike?.pathname || "");
    const match = pathname.replace(/\/+$/, "").match(/\/t\/(?:[^/]+\/)?(\d+)(?:\/\d+)?$/);
    return match?.[1] || "";
  }

  function extractTopicTitle(document) {
    return normalizeText(
      document.querySelector(".fancy-title, #topic-title, h1")?.textContent ||
      document.title
    );
  }

  function extractFirstPostText(document) {
    return normalizeText(
      document.querySelector('article.topic-post[data-post-id="1"] .cooked, article#post_1 .cooked')?.textContent
    );
  }

  function buildTopicContext(document, locationLike) {
    const topicUrl = String(locationLike?.href || "");

    return {
      topicId: extractTopicId(document, locationLike),
      topicUrl,
      title: extractTopicTitle(document),
      firstPostText: extractFirstPostText(document),
    };
  }

  function ensureStyle(document) {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${BANNER_ID} {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 14px 18px;
        color: #fff;
        font: 600 14px/1.4 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
        background: linear-gradient(135deg, #8b0000, #d62828);
      }

      #${BANNER_ID}[data-layout="nav"] {
        top: 10px;
        left: 50%;
        right: auto;
        transform: translateX(-50%);
        width: clamp(240px, 52vw, 560px);
        min-height: 40px;
        padding: 0 14px;
        gap: 10px;
        border: 1px solid #f1be55;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.98);
        color: #8a2f11;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
        pointer-events: none;
      }

      #${BANNER_ID}[hidden] {
        display: none;
      }

      #${BANNER_ID}[data-severity="idle"] {
        background: linear-gradient(135deg, #2d3436, #636e72);
      }

      #${BANNER_ID} .linuxdo-risk-monitor__content {
        flex: 1;
        min-width: 0;
      }

      #${BANNER_ID}[data-layout="nav"] .linuxdo-risk-monitor__content {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }

      #${BANNER_ID} .linuxdo-risk-monitor__message {
        font-size: 16px;
      }

      #${BANNER_ID}[data-layout="nav"] .linuxdo-risk-monitor__message {
        flex: 1;
        min-width: 0;
        font-size: 13px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      #${BANNER_ID} .linuxdo-risk-monitor__detail {
        margin-top: 4px;
        font-size: 12px;
        opacity: 0.95;
      }

      #${BANNER_ID}[data-layout="nav"] .linuxdo-risk-monitor__detail {
        margin-top: 0;
        flex: none;
        font-size: 12px;
        font-weight: 700;
        opacity: 1;
        white-space: nowrap;
        color: #b64700;
      }

      #${BANNER_ID} .linuxdo-risk-monitor__button {
        flex: none;
        border: 0;
        border-radius: 999px;
        padding: 8px 12px;
        background: rgba(255, 255, 255, 0.16);
        color: inherit;
        cursor: pointer;
        font: inherit;
      }

      #${BANNER_ID}[data-layout="nav"] .linuxdo-risk-monitor__button {
        display: none;
      }

      @media (max-width: 720px) {
        #${BANNER_ID}[data-layout="nav"] {
          top: 8px;
          width: calc(100vw - 110px);
          min-height: 36px;
          padding: 0 10px;
        }

        #${BANNER_ID}[data-layout="nav"] .linuxdo-risk-monitor__message {
          font-size: 12px;
        }

        #${BANNER_ID}[data-layout="nav"] .linuxdo-risk-monitor__detail {
          font-size: 11px;
        }
      }

      #${TOAST_ID} {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 2147483647;
        padding: 10px 14px;
        border-radius: 10px;
        background: rgba(30, 30, 30, 0.92);
        color: #fff;
        font: 500 13px/1.4 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
      }
    `;

    document.head?.appendChild(style);
  }

  function ensureBanner(document) {
    let banner = document.getElementById(BANNER_ID);
    if (banner) {
      return banner;
    }

    banner = document.createElement("section");
    banner.id = BANNER_ID;
    banner.hidden = true;
    banner.innerHTML = `
      <div class="linuxdo-risk-monitor__content">
        <div class="linuxdo-risk-monitor__message"></div>
        <div class="linuxdo-risk-monitor__detail"></div>
      </div>
      <button type="button" class="linuxdo-risk-monitor__button">停止监控</button>
    `;

    document.body?.prepend(banner);
    return banner;
  }

  function isOwnedNode(node) {
    if (!node || node.nodeType !== 1) {
      return false;
    }

    const element = node;
    if ([BANNER_ID, STYLE_ID, TOAST_ID].includes(element.id)) {
      return true;
    }

    return Boolean(element.closest?.(`#${BANNER_ID}, #${TOAST_ID}`));
  }

  function mutationNeedsRescan(mutation) {
    if (!mutation) {
      return false;
    }

    const changedNodes = [
      ...Array.from(mutation.addedNodes || []),
      ...Array.from(mutation.removedNodes || []),
    ].filter((node) => node.nodeType === 1);

    if (changedNodes.length > 0) {
      return changedNodes.some((node) => !isOwnedNode(node));
    }

    return !isOwnedNode(mutation.target);
  }

  function renderBanner(document, model, options) {
    ensureStyle(document);
    const banner = ensureBanner(document);
    const messageNode = banner.querySelector(".linuxdo-risk-monitor__message");
    const detailNode = banner.querySelector(".linuxdo-risk-monitor__detail");
    const stopButton = banner.querySelector(".linuxdo-risk-monitor__button");
    const compactCountMatch = String(model?.detail || "").match(/已记录\s+(\d+)\s+条风险评论/);
    const layout = document.querySelector(".d-header") ? "nav" : "page";
    const compactMessage = "风险帖子，请慎重发言";
    const compactDetail = compactCountMatch ? `风险评论 ${compactCountMatch[1]} 条` : "";

    banner.hidden = !model?.visible;
    banner.dataset.severity = model?.severity || "idle";
    banner.dataset.layout = layout;
    if (messageNode) {
      messageNode.textContent = layout === "nav" ? compactMessage : (model?.message || "");
    }

    if (detailNode) {
      detailNode.textContent = layout === "nav" ? compactDetail : (model?.detail || "");
    }

    if (stopButton) {
      stopButton.onclick = options?.onStop || null;
    }

    return banner;
  }

  function showToast(document, message, durationMs) {
    ensureStyle(document);
    let toast = document.getElementById(TOAST_ID);

    if (!toast) {
      toast = document.createElement("div");
      toast.id = TOAST_ID;
      document.body?.appendChild(toast);
    }

    toast.textContent = message;
    clearTimeout(showToast.timeoutId);
    showToast.timeoutId = setTimeout(() => {
      toast.remove();
    }, durationMs || 3500);
  }

  function buildState(context, cachedState, riskyPostIds, overrides) {
    const mergedIds = mergeRiskyPostIds(riskyPostIds, cachedState?.riskyPostIds);

    return {
      topicId: context.topicId,
      topicUrl: context.topicUrl,
      topicTitle: context.title,
      topicFirstPostText: context.firstPostText,
      riskyPostIds: mergedIds,
      riskyCount: mergedIds.length,
      lastScanAt: overrides?.lastScanAt || formatTimestamp(),
      stopped: Boolean(overrides?.stopped ?? cachedState?.stopped),
      stopReason: overrides?.stopReason ?? cachedState?.stopReason ?? null,
    };
  }

  function normalizeWatchlistEntry(entry) {
    const riskyPostIds = mergeRiskyPostIds(entry?.riskyPostIds || [], []);
    return {
      topicId: String(entry?.topicId || ""),
      topicUrl: entry?.topicUrl || "",
      topicTitle: entry?.title || entry?.topicTitle || "",
      topicFirstPostText: entry?.firstPostText || entry?.topicFirstPostText || "",
      riskyPostIds,
      lastKnownRiskCount: Number(entry?.lastKnownRiskCount ?? riskyPostIds.length),
      lastVisitedAt: entry?.lastVisitedAt || formatTimestamp(),
      lastScanAt: entry?.lastScanAt || entry?.lastVisitedAt || "未扫描",
      lastAlertAt: entry?.lastAlertAt || null,
      monitoring: entry?.monitoring ?? true,
      finished: entry?.finished ?? false,
      finishReason: entry?.finishReason ?? null,
    };
  }

  function upsertWatchlistEntry(watchlist, entry) {
    const normalized = normalizeWatchlistEntry(entry);
    const next = (watchlist || []).filter((item) => String(item.topicId) !== normalized.topicId);
    next.push(normalized);
    next.sort((left, right) => String(left.lastVisitedAt).localeCompare(String(right.lastVisitedAt)));
    return next.slice(-WATCHLIST_LIMIT);
  }

  function readWatchlist(storage) {
    const parsed = safeParseState(storage?.getItem?.(WATCHLIST_KEY));
    return Array.isArray(parsed)
      ? parsed.map((entry) => normalizeWatchlistEntry(entry)).filter((entry) => entry.topicId)
      : [];
  }

  function writeWatchlist(storage, watchlist) {
    try {
      storage?.setItem?.(WATCHLIST_KEY, JSON.stringify((watchlist || []).slice(-WATCHLIST_LIMIT)));
      return true;
    } catch (error) {
      return false;
    }
  }

  function diffRiskIncrease(entry, nextRiskyPostIds) {
    const merged = mergeRiskyPostIds(nextRiskyPostIds || [], entry?.riskyPostIds || []);
    const nextRiskCount = merged.length;
    const addedRiskCount = Math.max(0, nextRiskCount - Number(entry?.lastKnownRiskCount || 0));

    return {
      nextRiskyPostIds: merged,
      nextRiskCount,
      addedRiskCount,
    };
  }

  function buildBackgroundAlertMessage(topicTitle, addedRiskCount) {
    return `您刚浏览的帖子：${topicTitle} 新增了 ${addedRiskCount} 条风险评论！请务必谨慎发言！`;
  }

  function updateWatchlistEntryFromFetch(entry, fetchedState) {
    const diff = diffRiskIncrease(entry, fetchedState?.riskyPostIds || []);
    const finished = isFinishedTopic({
      title: fetchedState?.title,
      firstPostText: fetchedState?.firstPostText,
    });

    return {
      ...entry,
      topicTitle: fetchedState?.title || entry?.topicTitle || "",
      topicFirstPostText: fetchedState?.firstPostText || entry?.topicFirstPostText || "",
      riskyPostIds: diff.nextRiskyPostIds,
      lastKnownRiskCount: diff.nextRiskCount,
      lastScanAt: fetchedState?.lastScanAt || entry?.lastScanAt || "未扫描",
      lastAlertAt: entry?.lastAlertAt || null,
      monitoring: finished ? false : Boolean(entry?.monitoring),
      finished,
      finishReason: finished ? "auto-finished" : entry?.finishReason || null,
    };
  }

  async function scanWatchlistEntries(watchlist, fetchTopicState) {
    const nextWatchlist = [];
    const alerts = [];

    for (const rawEntry of watchlist || []) {
      const entry = normalizeWatchlistEntry(rawEntry);
      if (!entry.monitoring || entry.finished) {
        nextWatchlist.push(entry);
        continue;
      }

      let fetchedState = null;
      try {
        fetchedState = await fetchTopicState(entry);
      } catch (error) {
        fetchedState = null;
      }

      if (!fetchedState) {
        nextWatchlist.push(entry);
        continue;
      }

      const diff = diffRiskIncrease(entry, fetchedState.riskyPostIds);
      const updatedEntry = updateWatchlistEntryFromFetch(entry, {
        ...fetchedState,
        riskyPostIds: diff.nextRiskyPostIds,
      });

      if (diff.addedRiskCount > 0) {
        alerts.push({
          topicId: updatedEntry.topicId,
          topicTitle: updatedEntry.topicTitle,
          addedRiskCount: diff.addedRiskCount,
          message: buildBackgroundAlertMessage(updatedEntry.topicTitle, diff.addedRiskCount),
        });
      }

      nextWatchlist.push(updatedEntry);
    }

    return {
      watchlist: nextWatchlist,
      alerts,
    };
  }

  function buildInitialState(context, cachedState) {
    return buildState(context, cachedState, [], {
      lastScanAt: cachedState?.lastScanAt || "未扫描",
      stopped: cachedState?.stopped,
      stopReason: cachedState?.stopReason,
    });
  }

  function buildStableContext(currentContext, previousContext, state) {
    const currentKey = getStorageKey(currentContext);
    const previousKey = getStorageKey(previousContext);
    const sameTopic = currentKey && previousKey && currentKey === previousKey;

    if (!sameTopic) {
      return currentContext;
    }

    const rememberedContext = {
      title: state?.topicTitle || previousContext?.title,
      firstPostText: state?.topicFirstPostText || previousContext?.firstPostText,
    };

    if (isLotteryTopic(currentContext) || !isLotteryTopic(rememberedContext)) {
      return currentContext;
    }

    return {
      ...currentContext,
      title: rememberedContext.title || currentContext.title,
      firstPostText: rememberedContext.firstPostText || currentContext.firstPostText,
    };
  }

  function syncCurrentTopicToWatchlist(controller) {
    if (!isLotteryTopic(controller.context)) {
      return;
    }

    const watchlist = readWatchlist(controller.storage);
    const existing = watchlist.find((entry) => entry.topicId === String(controller.context.topicId));
    const shouldStayFinished = existing?.finishReason === "auto-finished" || controller.state.stopReason === "auto-finished";
    const nextWatchlist = upsertWatchlistEntry(watchlist, {
      ...existing,
      topicId: controller.context.topicId,
      topicUrl: controller.context.topicUrl,
      title: controller.context.title,
      firstPostText: controller.context.firstPostText,
      riskyPostIds: controller.state.riskyPostIds,
      lastKnownRiskCount: controller.state.riskyCount,
      lastVisitedAt: formatTimestamp(),
      lastScanAt: controller.state.lastScanAt,
      lastAlertAt: existing?.lastAlertAt || null,
      monitoring: shouldStayFinished ? false : true,
      finished: shouldStayFinished,
      finishReason: shouldStayFinished ? "auto-finished" : null,
    });

    writeWatchlist(controller.storage, nextWatchlist);
  }

  async function fetchTopicMonitorState(windowObject, entry) {
    if (typeof windowObject.fetch !== "function" || typeof windowObject.DOMParser !== "function") {
      return null;
    }

    const response = await windowObject.fetch(entry.topicUrl, {
      credentials: "include",
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    const parser = new windowObject.DOMParser();
    const document = parser.parseFromString(html, "text/html");
    const locationLike = new URL(entry.topicUrl, windowObject.location.origin);
    const context = buildTopicContext(document, locationLike);

    return {
      title: context.title || entry.topicTitle,
      firstPostText: context.firstPostText || entry.topicFirstPostText,
      riskyPostIds: scanRiskyPostIds(document),
      lastScanAt: formatTimestamp(),
    };
  }

  async function pollBackgroundWatchlist(controller) {
    if (controller.backgroundPollInFlight) {
      return;
    }

    controller.backgroundPollInFlight = true;

    try {
      const watchlist = readWatchlist(controller.storage);
      if (watchlist.length === 0) {
        return;
      }

      const result = await scanWatchlistEntries(watchlist, async (entry) => fetchTopicMonitorState(controller.window, entry));
      writeWatchlist(controller.storage, result.watchlist);

      result.alerts.forEach((alert, index) => {
        controller.window.setTimeout(() => {
          showToast(controller.document, alert.message, 1000);
        }, index * 1100);
      });
    } finally {
      controller.backgroundPollInFlight = false;
    }
  }

  function installSpaNavigationHooks(windowObject, onNavigate) {
    const historyObject = windowObject.history;
    const originalPushState = historyObject.pushState.bind(historyObject);
    const originalReplaceState = historyObject.replaceState.bind(historyObject);

    historyObject.pushState = function patchedPushState(...args) {
      const result = originalPushState(...args);
      onNavigate();
      return result;
    };

    historyObject.replaceState = function patchedReplaceState(...args) {
      const result = originalReplaceState(...args);
      onNavigate();
      return result;
    };

    const handlePopState = () => onNavigate();
    const handleHashChange = () => onNavigate();
    windowObject.addEventListener("popstate", handlePopState);
    windowObject.addEventListener("hashchange", handleHashChange);

    return () => {
      historyObject.pushState = originalPushState;
      historyObject.replaceState = originalReplaceState;
      windowObject.removeEventListener("popstate", handlePopState);
      windowObject.removeEventListener("hashchange", handleHashChange);
    };
  }

  function stopMonitoring(controller, reason) {
    if (controller.bootstrapTimeoutId) {
      controller.window.clearTimeout(controller.bootstrapTimeoutId);
      controller.bootstrapTimeoutId = null;
    }

    controller.state.stopped = true;
    controller.state.stopReason = reason;
    writeState(controller.storage, controller.context, controller.state);
    const watchlist = readWatchlist(controller.storage);
    const nextWatchlist = watchlist.map((entry) => (
      entry.topicId === String(controller.context.topicId)
        ? normalizeWatchlistEntry({
            ...entry,
            monitoring: false,
            finished: reason === "auto-finished",
            finishReason: reason,
          })
        : entry
    ));
    writeWatchlist(controller.storage, nextWatchlist);
    renderBanner(controller.document, buildBannerModel(controller.state), {
      onStop: () => stopMonitoring(controller, "manual"),
    });
  }

  function scheduleScan(controller, delayMs, options) {
    if (controller.state.stopped && !options?.force) {
      return;
    }

    if (controller.bootstrapTimeoutId) {
      controller.window.clearTimeout(controller.bootstrapTimeoutId);
    }

    controller.bootstrapTimeoutId = controller.window.setTimeout(() => {
      controller.bootstrapTimeoutId = null;
      performScan(controller);
    }, delayMs);
  }

  function hideBanner(document) {
    const banner = document.getElementById(BANNER_ID);
    if (banner) {
      banner.hidden = true;
    }
  }

  function performScan(controller) {
    const previousContext = controller.context;
    const rawContext = buildTopicContext(controller.document, controller.window.location);
    const currentKey = getStorageKey(rawContext);
    const previousKey = getStorageKey(previousContext);

    if (currentKey !== previousKey) {
      const cachedState = readState(controller.storage, rawContext) || {};
      controller.state = buildInitialState(rawContext, cachedState);
    }

    const currentContext = buildStableContext(rawContext, previousContext, controller.state);
    controller.context = currentContext;

    if (!isLotteryTopic(currentContext)) {
      hideBanner(controller.document);
      return controller.state;
    }

    const currentRiskyIds = scanRiskyPostIds(controller.document);
    const finished = isFinishedTopic(currentContext);
    const stopReason = controller.state.stopReason || (finished ? "auto-finished" : null);

    controller.state = buildState(currentContext, controller.state, currentRiskyIds, {
      stopped: controller.state.stopped || finished,
      stopReason,
    });

    writeState(controller.storage, currentContext, controller.state);
    syncCurrentTopicToWatchlist(controller);
    renderBanner(controller.document, buildBannerModel(controller.state), {
      onStop: () => {
        stopMonitoring(controller, "manual");
        showToast(controller.document, "已停止监控当前主题");
      },
    });

    return controller.state;
  }

  function registerStopMenu(controller) {
    if (typeof GM_registerMenuCommand !== "function") {
      return;
    }

    GM_registerMenuCommand("停止监控当前主题", () => {
      stopMonitoring(controller, "manual");
      showToast(controller.document, "已停止监控当前主题");
    });
  }

  function initRiskMonitor(windowObject) {
    const context = buildTopicContext(windowObject.document, windowObject.location);
    const cachedState = readState(windowObject.localStorage, context) || {};
    const controller = {
      window: windowObject,
      document: windowObject.document,
      storage: windowObject.localStorage,
      context,
      state: buildInitialState(context, cachedState),
      intervalId: null,
      backgroundIntervalId: null,
      bootstrapTimeoutId: null,
      observer: null,
      navigationCleanup: null,
      backgroundPollInFlight: false,
    };

    registerStopMenu(controller);
    controller.navigationCleanup = installSpaNavigationHooks(windowObject, () => {
      const pathname = String(windowObject.location?.pathname || "");

      if (!pathname.startsWith("/t/")) {
        hideBanner(controller.document);
      }

      scheduleScan(controller, 0, { force: true });
      scheduleScan(controller, 400, { force: true });
    });
    performScan(controller);

    controller.intervalId = windowObject.setInterval(() => {
      performScan(controller);
    }, POLL_INTERVAL_MS);
    controller.backgroundIntervalId = windowObject.setInterval(() => {
      pollBackgroundWatchlist(controller);
    }, POLL_INTERVAL_MS);

    if (typeof windowObject.MutationObserver === "function" && windowObject.document.body) {
      controller.observer = new windowObject.MutationObserver((mutations) => {
        const shouldScan = Array.from(mutations || []).some((mutation) => mutationNeedsRescan(mutation));

        if (shouldScan) {
          scheduleScan(controller, 250);
        }
      });
      controller.observer.observe(windowObject.document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }

    windowObject.addEventListener("focus", () => {
      performScan(controller);
    });

    return controller;
  }

  const api = {
    isLotteryTopic,
    isFinishedTopic,
    scanRiskyPostIds,
    mergeRiskyPostIds,
    buildBannerModel,
    getStorageKey,
    renderBanner,
    buildTopicContext,
    initRiskMonitor,
    installSpaNavigationHooks,
    upsertWatchlistEntry,
    readWatchlist,
    writeWatchlist,
    diffRiskIncrease,
    buildBackgroundAlertMessage,
    updateWatchlistEntryFromFetch,
    scanWatchlistEntries,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  if (typeof window === "undefined" || !window.document) {
    return;
  }

  initRiskMonitor(window);
})();
