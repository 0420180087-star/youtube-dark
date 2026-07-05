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

    const client_id = Deno.env.get('GOOGLE_CLIENT_ID') || body.client_id
    const client_secret = Deno.env.get('YOUTUBE_CLIENT_SECRET') || Deno.env.get('GOOGLE_CLIENT_SECRET')

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

    let channel: any = null
    try {
      const chRes = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
      const chData = await chRes.json()
      const ch = chData.items?.[0]
      if (ch?.id) {
        channel = {
          id: ch.id,
          title: ch.snippet?.title || '',
          thumbnailUrl: ch.snippet?.thumbnails?.default?.url || '',
          subscriberCount: ch.statistics?.subscriberCount || '',
        }
      }
    } catch (e) {
      console.warn('Could not fetch YouTube channel metadata:', e)
    }

    await supabaseAdmin.from('project_auth').upsert({
      project_id,
      user_email,
      youtube_channel_id: channel?.id || null,
      youtube_channel_title: channel?.title || null,
      youtube_access_token: tokens.access_token,
      youtube_refresh_token: refreshTokenToStore,
      oauth_client_id: client_id,
      token_expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'project_id,user_email' })

    return new Response(
      JSON.stringify({ access_token: tokens.access_token, expires_at: expiresAt, channel }),
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
