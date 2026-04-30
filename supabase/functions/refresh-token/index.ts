import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? 'https://yourdomain.com',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  try {
    const { project_id, user_email } = await req.json()

    if (!user_email) {
      return new Response(
        JSON.stringify({ error: 'user_email é obrigatório' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2')
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Look up refresh_token — try specific project_id first, then any for this user
    let data: any = null
    let error: any = null

    if (project_id && project_id !== 'default') {
      const result = await supabaseAdmin
        .from('project_auth')
        .select('youtube_refresh_token, youtube_access_token, token_expires_at')
        .eq('project_id', project_id)
        .single()
      data = result.data
      error = result.error
    }

    // Fallback: find ANY auth row for this user (most recently updated)
    if (!data?.youtube_refresh_token) {
      const result = await supabaseAdmin
        .from('project_auth')
        .select('youtube_refresh_token, youtube_access_token, token_expires_at')
        .eq('user_email', user_email)
        .order('updated_at', { ascending: false })
        .limit(1)
        .single()
      data = result.data
      error = result.error
    }

    if (error || !data?.youtube_refresh_token) {
      return new Response(
        JSON.stringify({ error: 'Nenhum refresh_token encontrado para este usuário. Reconecte o YouTube no app.' }),
        { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    // If current token still valid (5min margin), return it directly
    if (data.token_expires_at) {
      const expiresAt = new Date(data.token_expires_at)
      if (expiresAt.getTime() - Date.now() > 5 * 60 * 1000) {
        return new Response(
          JSON.stringify({ access_token: data.youtube_access_token, expires_at: data.token_expires_at }),
          { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        )
      }
    }

    // Token expired — refresh via Google
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refresh_token: data.youtube_refresh_token,
        client_id: Deno.env.get('GOOGLE_CLIENT_ID'),
        client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET'),
        grant_type: 'refresh_token',
      }),
    })

    const tokens = await tokenRes.json()

    if (!tokens.access_token) {
      console.error('Token refresh failed:', tokens)
      return new Response(
        JSON.stringify({ error: tokens.error_description || 'Falha ao renovar token' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString()

    // Save new access_token back — update all rows for this user
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
      { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('Refresh token error:', err)
    return new Response(
      JSON.stringify({ error: 'Erro interno do servidor' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )
  }
})
