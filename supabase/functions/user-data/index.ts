/**
 * user-data — acesso privilegiado (service_role) às tabelas sensíveis
 * `user_settings` e `project_auth`, que deixaram de ser legíveis pelo
 * navegador (anon/authenticated revogados no bootstrap.sql).
 *
 * AUTENTICAÇÃO: o navegador envia o `access_token` do Google (obtido no login
 * via GIS) no cabeçalho Authorization. Ele é validado contra o endpoint
 * `userinfo` do Google e o e-mail usado é SEMPRE o do token — nunca o do corpo
 * da requisição. Assim um usuário não consegue ler dados de outro.
 *
 * Ações:
 *   get_settings          -> { gemini_api_keys, pexels_api_key }
 *   save_settings         -> upsert das chaves do próprio usuário
 *   get_project_auth      -> status de token por projeto (NUNCA os tokens)
 *   delete_project_auth   -> remove a conexão de um projeto
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const getCorsHeaders = (req: Request) => {
  const origin = req.headers.get('origin') ?? ''
  const allowed = Deno.env.get('ALLOWED_ORIGIN') ?? ''
  const allowOrigin = !allowed || allowed === '*' ? '*'
    : origin === allowed ? origin
    : 'null'
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
}

const json = (body: unknown, status: number, CORS: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

/** Valida o access_token do Google e devolve o e-mail verificado. */
async function verifyGoogleToken(token: string): Promise<string | null> {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const info = await res.json()
    const email = String(info?.email || '').trim().toLowerCase()
    return email || null
  } catch {
    return null
  }
}

serve(async (req) => {
  const CORS = getCorsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: CORS })

  try {
    const authHeader = req.headers.get('authorization') || ''
    const token = authHeader.replace(/^Bearer\s+/i, '').trim()
    if (!token) return json({ error: 'Authorization ausente' }, 401, CORS)

    const email = await verifyGoogleToken(token)
    if (!email) return json({ error: 'Token do Google inválido ou expirado' }, 401, CORS)

    const { action, project_id, gemini_api_keys, pexels_api_key } = await req.json()

    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2')
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    if (action === 'get_settings') {
      const { data, error } = await admin
        .from('user_settings')
        .select('gemini_api_keys, pexels_api_key')
        .eq('user_email', email)
        .maybeSingle()
      if (error) return json({ error: error.message }, 500, CORS)
      return json({
        gemini_api_keys: data?.gemini_api_keys ?? [],
        pexels_api_key: data?.pexels_api_key ?? null,
      }, 200, CORS)
    }

    if (action === 'save_settings') {
      if (!Array.isArray(gemini_api_keys)) {
        return json({ error: 'gemini_api_keys deve ser uma lista' }, 400, CORS)
      }
      const { error } = await admin.from('user_settings').upsert({
        user_email: email,
        gemini_api_keys,
        pexels_api_key: pexels_api_key || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_email' })
      if (error) return json({ error: error.message }, 500, CORS)
      return json({ ok: true }, 200, CORS)
    }

    if (action === 'get_project_auth') {
      const { data, error } = await admin
        .from('project_auth')
        .select('project_id, youtube_refresh_token, token_status, token_error, youtube_channel_title')
        .eq('user_email', email)
      if (error) return json({ error: error.message }, 500, CORS)
      // NUNCA devolver tokens — só o suficiente para o painel de saúde.
      const rows = (data ?? []).map((r: any) => ({
        project_id: r.project_id,
        has_refresh_token: !!r.youtube_refresh_token,
        token_status: r.token_status ?? null,
        token_error: r.token_error ?? null,
        youtube_channel_title: r.youtube_channel_title ?? null,
      }))
      return json({ rows }, 200, CORS)
    }

    if (action === 'delete_project_auth') {
      if (!project_id) return json({ error: 'project_id é obrigatório' }, 400, CORS)
      const { error } = await admin
        .from('project_auth')
        .delete()
        .eq('project_id', project_id)
        .eq('user_email', email)
      if (error) return json({ error: error.message }, 500, CORS)
      return json({ ok: true }, 200, CORS)
    }

    return json({ error: `Ação desconhecida: ${action}` }, 400, CORS)
  } catch (e) {
    return json({ error: (e as Error).message }, 500, CORS)
  }
})
