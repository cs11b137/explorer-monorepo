	.intel_syntax noprefix
	.file	"sum.c"
	.text
	.globl	sum                             # -- Begin function sum
	.p2align	4
	.type	sum,@function
sum:                                    # @sum
# %bb.0:
	push	rbp
	mov	rbp, rsp
	sub	rsp, 32
	mov	dword ptr [rbp - 4], edi
	mov	dword ptr [rbp - 8], 2
	imul	eax, dword ptr [rbp - 8], 3
	mov	dword ptr [rbp - 12], eax
	mov	eax, dword ptr [rbp - 12]
	add	eax, 1
	mov	dword ptr [rbp - 16], eax
	mov	dword ptr [rbp - 20], 0
	mov	dword ptr [rbp - 24], 0
.LBB0_1:                                # =>This Inner Loop Header: Depth=1
	mov	eax, dword ptr [rbp - 24]
	cmp	eax, dword ptr [rbp - 4]
	jge	.LBB0_3
# %bb.2:                                #   in Loop: Header=BB0_1 Depth=1
	mov	eax, dword ptr [rbp - 20]
	mov	ecx, dword ptr [rbp - 12]
	imul	ecx, dword ptr [rbp - 4]
	add	eax, ecx
	add	eax, dword ptr [rbp - 24]
	mov	dword ptr [rbp - 20], eax
	mov	eax, dword ptr [rbp - 24]
	add	eax, 1
	mov	dword ptr [rbp - 24], eax
	jmp	.LBB0_1
.LBB0_3:
	mov	eax, dword ptr [rbp - 20]
	mov	dword ptr [rip + total], eax
	mov	edi, dword ptr [rbp - 20]
	call	scale@PLT
	add	eax, dword ptr [rbp - 4]
	add	rsp, 32
	pop	rbp
	ret
.Lfunc_end0:
	.size	sum, .Lfunc_end0-sum
                                        # -- End function
	.type	total,@object                   # @total
	.bss
	.globl	total
	.p2align	2, 0x0
total:
	.long	0                               # 0x0
	.size	total, 4

	.ident	"Apple clang version 21.0.0 (clang-2100.4.1.1)"
	.section	".note.GNU-stack","",@progbits
	.addrsig
	.addrsig_sym scale
	.addrsig_sym total
