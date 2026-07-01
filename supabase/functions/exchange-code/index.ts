import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const getCorsHeaders = (req: Request) => {
  const origin = req.headers.get('origin') ?? ''
  const allowed = Deno.env.get('ALLOWED_ORIGIN') ?? ''
  const allowOrigin = !allowed || allowed === '*' ? '*'
    : origin === allowed ? origin
    : allowed

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
}

serve(async (req) => {
  const CORS = getCorsHeaders(req)

  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: CORS })
  }

  try {
    const body = await req.json()
    const { code, redirect_uri, project_id, user_email } = body

    if (!code || !redirect_uri || !project_id || !user_email) {
      return new Response(
        JSON.stringify({ error: 'Parâmetros obrigatórios ausentes' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    const client_id = body.client_id || Deno.env.get('GOOGLE_CLIENT_ID')
    const client_secret = body.client_secret || Deno.env.get('YOUTUBE_CLIENT_SECRET') || Deno.env.get('GOOGLE_CLIENT_SECRET')

    if (!client_id || !client_secret) {
      return new Response(
        JSON.stringify({ error: 'client_id ou client_secret ausentes. Configure GOOGLE_CLIENT_ID e YOUTUBE_CLIENT_SECRET nas secrets do Supabase.' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id,
        client_secret,
        redirect_uri,
        grant_type: 'authorization_code',
      }),
    })

    const tokens = await tokenRes.json()

    if (!tokens.access_token) {
      console.error('Token exchange failed:', tokens)
      return new Response(
        JSON.stringify({ error: tokens.error_description || 'Falha na troca de tokens' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2')
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString()

    const existing = await supabaseAdmin
      .from('project_auth')
      .select('youtube_refresh_token')
      .eq('project_id', project_id)
      .eq('user_email', user_email)
      .maybeSingle()

    const refreshTokenToStore = tokens.refresh_token || existing.data?.youtube_refresh_token
    if (!refreshTokenToStore) {
      return new Response(
        JSON.stringify({ error: 'Google não retornou refresh_token. Remova o acesso do app na conta Google e conecte novamente com consentimento offline.' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    await supabaseAdmin.from('project_auth').upsert({
      project_id,
      user_email,
      youtube_access_token: tokens.access_token,
      youtube_refresh_token: refreshTokenToStore,
      token_expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'project_id,user_email' })

    return new Response(
      JSON.stringify({ access_token: tokens.access_token, expires_at: expiresAt }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('Edge function error:', err)
    return new Response(
      JSON.stringify({ error: 'Erro interno do servidor' }),
      { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } }
    )
  }
})
