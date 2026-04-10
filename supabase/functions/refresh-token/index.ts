import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  try {
    const { project_id, user_email } = await req.json()

    if (!project_id || !user_email) {
      return new Response(
        JSON.stringify({ error: 'project_id e user_email são obrigatórios' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2')
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Buscar o refresh_token do Supabase
    const { data, error } = await supabaseAdmin
      .from('project_auth')
      .select('youtube_refresh_token, token_expires_at')
      .eq('project_id', project_id)
      .single()

    if (error || !data?.youtube_refresh_token) {
      return new Response(
        JSON.stringify({ error: 'refresh_token não encontrado para este projeto' }),
        { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }

    // Verificar se o token atual ainda é válido (com 5min de margem)
    if (data.token_expires_at) {
      const expiresAt = new Date(data.token_expires_at)
      if (expiresAt.getTime() - Date.now() > 5 * 60 * 1000) {
        // Token ainda válido — buscar o access_token atual
        const { data: authData } = await supabaseAdmin
          .from('project_auth')
          .select('youtube_access_token')
          .eq('project_id', project_id)
          .single()
        
        return new Response(
          JSON.stringify({ access_token: authData?.youtube_access_token, expires_at: data.token_expires_at }),
          { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        )
      }
    }

    // Token expirado — renovar usando refresh_token
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

    // Salvar o novo access_token e expires_at no Supabase
    await supabaseAdmin.from('project_auth').update({
      youtube_access_token: tokens.access_token,
      token_expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }).eq('project_id', project_id)

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
