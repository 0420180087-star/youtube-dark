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
    const { project_id, user_email, client_id, client_secret } = await req.json()

    if (!user_email) {
      return new Response(
        JSON.stringify({ error: 'user_email é obrigatório' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    const activeClientId = client_id || Deno.env.get('GOOGLE_CLIENT_ID')
    const activeClientSecret = client_secret || Deno.env.get('YOUTUBE_CLIENT_SECRET')

    if (!activeClientId || !activeClientSecret) {
      return new Response(
        JSON.stringify({ error: 'client_id ou client_secret ausentes' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2')
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    let data: any = null

    if (project_id && project_id !== 'default') {
      const result = await supabaseAdmin
        .from('project_auth')
        .select('youtube_refresh_token, youtube_access_token, token_expires_at')
        .eq('project_id', project_id)
        .eq('user_email', user_email)
        .maybeSingle()
      data = result.data
    }

    if (!data?.youtube_refresh_token) {
      const result = await supabaseAdmin
        .from('project_auth')
        .select('youtube_refresh_token, youtube_access_token, token_expires_at')
        .eq('user_email', user_email)
        .not('youtube_refresh_token', 'is', null)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      data = result.data
    }

    if (!data?.youtube_refresh_token) {
      return new Response(
        JSON.stringify({ error: 'Nenhum refresh_token encontrado. Reconecte o YouTube no app.' }),
        { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    // Token ainda válido (margem 5min) — retorna direto
    if (data.token_expires_at) {
      const expiresAt = new Date(data.token_expires_at)
      if (expiresAt.getTime() - Date.now() > 5 * 60 * 1000) {
        return new Response(
          JSON.stringify({ access_token: data.youtube_access_token, expires_at: data.token_expires_at }),
          { headers: { ...CORS, 'Content-Type': 'application/json' } }
        )
      }
    }

    // Token expirado — renova via Google
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refresh_token: data.youtube_refresh_token,
        client_id: activeClientId,
        client_secret: activeClientSecret,
        grant_type: 'refresh_token',
      }),
    })

    const tokens = await tokenRes.json()

    if (!tokens.access_token) {
      console.error('Token refresh failed:', tokens)
      return new Response(
        JSON.stringify({ error: tokens.error_description || 'Falha ao renovar token' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString()

    await supabaseAdmin
      .from('project_auth')
      .update({
        youtube_access_token: tokens.access_token,
        token_expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq('user_email', user_email)

    return new Response(
      JSON.stringify({ access_token: tokens.access_token, expires_at: expiresAt }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('Refresh token error:', err)
    return new Response(
      JSON.stringify({ error: 'Erro interno do servidor' }),
      { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } }
    )
  }
})
