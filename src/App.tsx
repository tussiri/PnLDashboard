import { LoginPage } from './auth/LoginPage'
import { AuthProvider, useAuth } from './auth/useAuth'
import { Account } from './leadership/pages/Account'
import { Admin } from './leadership/pages/Admin'
import { Analytics } from './leadership/pages/Analytics'
import { Company } from './leadership/pages/Company'
import { Shell } from './leadership/Shell'
import { LeadershipProvider, useLeadership } from './leadership/state'
import { Skeleton } from './leadership/ui'

function Page() {
  const { route, config, decision, user, can, unlimited } = useLeadership()
  if (!decision || (!config.data && !config.error)) return <Skeleton height={420} />
  // Company (the landing page) and Portfolio cover every account: a user limited to some accounts, or without
  // the permission, lands on their account instead.
  if (route.view === 'company' && unlimited && can('view.company')) return <Company />
  if (route.view === 'analytics' && unlimited && can('view.analytics')) return <Analytics />
  if (route.view === 'admin') return <Admin />
  return <Account />
}

function Gate() {
  const { status, user, signOut } = useAuth()
  if (status === 'checking') return <main className="login" aria-busy="true"><Skeleton height={200} /></main>
  if (status === 'signed_out' || !user) return <LoginPage />
  return <LeadershipProvider key={user.username} user={user} signOut={() => { void signOut() }}><Shell><Page /></Shell></LeadershipProvider>
}

export default function App() {
  return <AuthProvider><Gate /></AuthProvider>
}
