import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/overview' },
    { path: '/dashboard', redirect: '/overview' },
    { path: '/overview', component: () => import('../views/Overview.vue') },
    { path: '/library', component: () => import('../views/Library.vue') },
    { path: '/entry', component: () => import('../views/Entry.vue') },
    { path: '/pipeline', component: () => import('../views/Pipeline.vue') },
    { path: '/domains', component: () => import('../views/Domains.vue') },
    { path: '/supply', component: () => import('../views/Supply.vue') },
    { path: '/settings', component: () => import('../views/Settings.vue') }
  ]
})

export default router
