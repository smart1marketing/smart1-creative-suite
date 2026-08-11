import { config } from '../config.js';
import { log } from './store.js';

async function post(url, payload, label) {
  if (!url) throw new Error(`No webhook URL configured for ${label}.`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`GHL ${label} returned ${res.status}: ${body.slice(0, 200)}`);
  log.info(`ghl.${label}`, `Sent for ${payload.projectName || payload.projectId}`);
  return { ok: true, status: res.status, response: body.slice(0, 500) };
}

/** Flatten a project into the shape a GHL opportunity workflow expects. */
export function opportunityPayload(project) {
  const c = project.customer || {};
  const approved = (project.playlist || []).map((item) => ({
    toneId: item.toneId,
    tone: item.toneLabel,
    length: `${item.seconds}s`,
    script: item.script,
    voice: item.voiceName,
    voiceId: item.voiceId,
    audioUrl: item.audioUrl || null,
    bannerUrl: item.bannerUrl || null,
    bannerClickUrl: item.clickThroughUrl || null,
    measuredSeconds: item.finalSeconds || null,
    musicBed: item.bedName || 'none'
  }));

  return {
    source: 'Smart 1 Radio Studio',
    projectId: project.projectId,
    createdAt: project.createdAt,
    // contact
    name: c.customerName,
    email: c.email,
    company: c.company || project.brand?.name || '',
    // opportunity
    opportunityName: `${c.company || c.customerName} — ${c.projectName}`,
    pipelineStage: 'Radio Creative Complete',
    projectName: c.projectName,
    teamMember: c.teamMember,
    homeUrl: c.homeUrl,
    landingUrl: c.landingUrl,
    promotionDetails: c.promotion,
    disclaimer: c.disclaimer || '',
    // Companion banners are clickable — this is where the click goes.
    bannerClickThroughUrl: c.landingUrl || c.homeUrl || '',
    // creative
    tones: (project.tones || []).join(', '),
    spotCount: approved.length,
    cloudinaryFolder: project.cloudinaryFolder,
    logoUrl: project.brand?.logo || null,
    reviewUrl: project.reviewUrl || null,
    audioUrls: approved.map((a) => a.audioUrl).filter(Boolean),
    bannerUrls: [...new Set(approved.map((a) => a.bannerUrl).filter(Boolean))],
    commercials: approved,
    brief: {
      summary: project.analysis?.summary,
      audience: project.analysis?.audience,
      offer: project.analysis?.offer,
      callToAction: project.analysis?.callToAction
    }
  };
}

/** Fires when the reviewer actually clicks approve or asks for changes. */
export const sendReviewDecision = (project, decision) =>
  post(
    config.ghl.responseWebhook || config.ghl.approvalWebhook,
    {
      ...opportunityPayload(project),
      event: decision.outcome === 'approved' ? 'playlist_approved' : 'changes_requested',
      decision: decision.outcome,
      decidedAt: decision.decidedAt,
      decidedBy: decision.by || project.approvalRequest?.recipientEmail || '',
      reviewerComments: decision.comments || ''
    },
    'review-decision'
  );

export const sendOpportunity = (project) =>
  post(config.ghl.opportunityWebhook, opportunityPayload(project), 'opportunity');

export const sendForApproval = (project, { recipientName, recipientEmail, comments }) =>
  post(
    config.ghl.approvalWebhook,
    {
      ...opportunityPayload(project),
      approvalRequestedAt: new Date().toISOString(),
      approverName: recipientName,
      approverEmail: recipientEmail,
      approvalComments: comments || '',
      reviewLinks: (project.playlist || []).map((i) => ({
        label: `${i.toneLabel} — ${i.seconds}s`,
        audio: i.audioUrl,
        banner: i.bannerUrl
      }))
    },
    'approval'
  );
