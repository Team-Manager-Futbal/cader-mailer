import { useState } from 'react'
import { Alert, Badge, Button, Card, Checkbox, Field, Input, Loading, PageHeader, Select, TableWrap, Td, Th } from '../components/ui'
import { useAuth } from '../lib/auth'
import { must, senderLabel, useLoad } from '../lib/data'
import { ApiError, callFunction, dbError, supabase } from '../lib/supabase'
import { formatLocal } from '../lib/time'
import type { Profile, Role, SenderAccount } from '../lib/types'

export function UsersPage() {
  const { profile: me } = useAuth()
  const data = useLoad(async () => {
    const [profiles, senders, perms] = await Promise.all([
      must(supabase.from('profiles').select('*').order('created_at')),
      must(supabase.from('sender_accounts').select('*').order('email')),
      must(supabase.from('sender_permissions').select('user_id, sender_id')),
    ])
    return { profiles: profiles as Profile[], senders: senders as SenderAccount[], perms: perms as { user_id: string; sender_id: string }[] }
  })
  const [invite, setInvite] = useState({ email: '', full_name: '', role: 'member' as Role })
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  async function sendInvite() {
    setBusy('invite')
    setMsg(null)
    try {
      await callFunction('admin-users', { action: 'invite', ...invite })
      setMsg({ tone: 'success', text: `Pozvánka odoslaná na ${invite.email}.` })
      setInvite({ email: '', full_name: '', role: 'member' })
      data.reload()
    } catch (e) {
      setMsg({ tone: 'error', text: e instanceof ApiError ? e.message : 'Pozvánka zlyhala.' })
    } finally {
      setBusy(null)
    }
  }

  async function update(p: Profile, changes: Partial<Pick<Profile, 'role' | 'active'>>) {
    setBusy(p.user_id)
    setMsg(null)
    try {
      await callFunction('admin-users', { action: 'update', user_id: p.user_id, role: changes.role ?? p.role, active: changes.active ?? p.active })
      data.reload()
    } catch (e) {
      setMsg({ tone: 'error', text: e instanceof ApiError ? (e.code === 'last_admin' ? 'Musí zostať aspoň jeden aktívny admin.' : e.code === 'cannot_demote_self' ? 'Nemôžete zmeniť vlastnú rolu ani sa deaktivovať.' : e.message) : 'Zmena zlyhala.' })
    } finally {
      setBusy(null)
    }
  }

  async function togglePerm(userId: string, senderId: string, on: boolean) {
    const { error } = on
      ? await supabase.from('sender_permissions').insert({ user_id: userId, sender_id: senderId, granted_by: me!.user_id })
      : await supabase.from('sender_permissions').delete().eq('user_id', userId).eq('sender_id', senderId)
    if (error) setMsg({ tone: 'error', text: dbError(error) })
    data.reload()
  }

  return (
    <>
      <PageHeader title="Používatelia" description="Prístup je len na pozvánku. Odosielateľov môže členom prideliť iba admin." />
      <div className="space-y-6">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <Card title="Pozvať člena tímu">
          <div className="grid items-end gap-4 md:grid-cols-[1fr_1fr_10rem_auto]">
            <Field label="E-mail" htmlFor="inv-email">
              <Input id="inv-email" type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
            </Field>
            <Field label="Meno" htmlFor="inv-name">
              <Input id="inv-name" value={invite.full_name} onChange={(e) => setInvite({ ...invite, full_name: e.target.value })} />
            </Field>
            <Field label="Rola" htmlFor="inv-role">
              <Select id="inv-role" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value as Role })}>
                <option value="member">Člen</option>
                <option value="admin">Admin</option>
              </Select>
            </Field>
            <Button variant="primary" busy={busy === 'invite'} onClick={sendInvite} disabled={!invite.email}>
              Poslať pozvánku
            </Button>
          </div>
        </Card>

        {data.error && <Alert tone="error">{data.error}</Alert>}
        {data.loading && !data.data && <Loading />}
        {data.data && (
          <Card title={`Tím (${data.data.profiles.length})`}>
            <TableWrap>
              <thead>
                <tr>
                  <Th>Používateľ</Th>
                  <Th>Rola</Th>
                  <Th>Stav</Th>
                  <Th>Pridelení odosielatelia</Th>
                  <Th>Vytvorený</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {data.data.profiles.map((p) => {
                  const self = p.user_id === me?.user_id
                  return (
                    <tr key={p.user_id}>
                      <Td>
                        <p className="font-medium">{p.full_name || '–'}</p>
                        <p className="text-xs text-stone-500">{p.email}</p>
                      </Td>
                      <Td>
                        <Select aria-label={`Rola ${p.email}`} value={p.role} disabled={self || busy === p.user_id} onChange={(e) => update(p, { role: e.target.value as Role })} className="w-28">
                          <option value="member">Člen</option>
                          <option value="admin">Admin</option>
                        </Select>
                      </Td>
                      <Td>
                        <div className="flex items-center gap-2">
                          {p.active ? <Badge tone="green">Aktívny</Badge> : <Badge tone="red">Neaktívny</Badge>}
                          {!self && (
                            <Button variant="ghost" className="px-2 py-1 text-xs" busy={busy === p.user_id} onClick={() => update(p, { active: !p.active })}>
                              {p.active ? 'Deaktivovať' : 'Aktivovať'}
                            </Button>
                          )}
                        </div>
                      </Td>
                      <Td>
                        {p.role === 'admin' ? (
                          <span className="text-xs text-stone-500">Admin môže použiť všetkých</span>
                        ) : data.data!.senders.length === 0 ? (
                          <span className="text-xs text-stone-500">Žiadni odosielatelia</span>
                        ) : (
                          <div className="space-y-1">
                            {data.data!.senders.map((s) => (
                              <Checkbox
                                key={s.id}
                                checked={data.data!.perms.some((x) => x.user_id === p.user_id && x.sender_id === s.id)}
                                onChange={(e) => togglePerm(p.user_id, s.id, e.target.checked)}
                                label={<span className="text-xs">{senderLabel(s)}</span>}
                              />
                            ))}
                          </div>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap">{formatLocal(p.created_at)}</Td>
                    </tr>
                  )
                })}
              </tbody>
            </TableWrap>
          </Card>
        )}
      </div>
    </>
  )
}
