package net.integr.osmium.account.repository

import net.integr.osmium.account.model.PermissionNode
import org.springframework.data.jpa.repository.JpaRepository

interface PermissionNodeRepository : JpaRepository<PermissionNode, String>
