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
    const { project_id, user_email, client_id } = await req.json()

    if (!user_email) {
      return new Response(
        JSON.stringify({ error: 'user_email é obrigatório' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    const activeClientId = Deno.env.get('GOOGLE_CLIENT_ID') || client_id
    const activeClientSecret = Deno.env.get('YOUTUBE_CLIENT_SECRET') || Deno.env.get('GOOGLE_CLIENT_SECRET')

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

    const selectAuthRow = async (scopedProjectId?: string) => {
      const baseSelect = 'project_id, user_email, youtube_refresh_token, youtube_access_token, token_expires_at, youtube_channel_id, youtube_channel_title'
      let query = supabaseAdmin.from('project_auth').select(baseSelect).eq('user_email', user_email)
      if (scopedProjectId) query = query.eq('project_id', scopedProjectId)
      else query = query.not('youtube_refresh_token', 'is', null).order('updated_at', { ascending: false }).limit(1)
      let result = await query.maybeSingle()

      if (result.error && (result.error.message || '').includes('youtube_channel')) {
        let legacy = supabaseAdmin
          .from('project_auth')
          .select('project_id, user_email, youtube_refresh_token, youtube_access_token, token_expires_at')
          .eq('user_email', user_email)
        if (scopedProjectId) legacy = legacy.eq('project_id', scopedProjectId)
        else legacy = legacy.not('youtube_refresh_token', 'is', null).order('updated_at', { ascending: false }).limit(1)
        result = await legacy.maybeSingle()
      }

      if (result.error) throw result.error
      return result.data
    }

    if (project_id && project_id !== 'default') {
      data = await selectAuthRow(project_id)
    } else {
      data = await selectAuthRow()
    }

    if (!data?.youtube_refresh_token) {
      const scopedMsg = project_id && project_id !== 'default'
        ? 'Nenhum refresh_token encontrado para este projeto. Reconecte o YouTube na aba Settings do projeto.'
        : 'Nenhum refresh_token encontrado. Reconecte o YouTube no app.'
      return new Response(
        JSON.stringify({ error: scopedMsg }),
        { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    // Sempre renova antes do upload/login automático.
    // Não retornamos token cacheado aqui porque ele pode ter sido revogado antes
    // de token_expires_at; o usuário pediu explicitamente refresh antes de postar.
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
      const needsReconnect = tokens.error === 'invalid_grant'
      return new Response(
        JSON.stringify({
          error: tokens.error_description || 'Falha ao renovar token',
          needsReconnect,
        }),
        { status: needsReconnect ? 401 : 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
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
      .eq('project_id', data.project_id)
      .eq('user_email', data.user_email)

    return new Response(
      JSON.stringify({
        access_token: tokens.access_token,
        expires_at: expiresAt,
        project_id: data.project_id,
        youtube_channel_id: data.youtube_channel_id,
        youtube_channel_title: data.youtube_channel_title,
      }),
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
