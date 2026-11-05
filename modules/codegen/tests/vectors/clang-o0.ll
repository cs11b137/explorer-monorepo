; ModuleID = 'sum.c'
source_filename = "sum.c"
target datalayout = "e-m:e-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128"
target triple = "x86_64-unknown-linux-gnu"

@total = dso_local global i32 0, align 4

; Function Attrs: noinline nounwind optnone
define dso_local i32 @sum(i32 noundef %n) #0 {
entry:
  %n.addr = alloca i32, align 4
  %k = alloca i32, align 4
  %m = alloca i32, align 4
  %d = alloca i32, align 4
  %s = alloca i32, align 4
  %i = alloca i32, align 4
  store i32 %n, ptr %n.addr, align 4
  store i32 2, ptr %k, align 4
  %0 = load i32, ptr %k, align 4
  %mul = mul nsw i32 %0, 3
  store i32 %mul, ptr %m, align 4
  %1 = load i32, ptr %m, align 4
  %add = add nsw i32 %1, 1
  store i32 %add, ptr %d, align 4
  store i32 0, ptr %s, align 4
  store i32 0, ptr %i, align 4
  br label %while.cond

while.cond:                                       ; preds = %while.body, %entry
  %2 = load i32, ptr %i, align 4
  %3 = load i32, ptr %n.addr, align 4
  %cmp = icmp slt i32 %2, %3
  br i1 %cmp, label %while.body, label %while.end

while.body:                                       ; preds = %while.cond
  %4 = load i32, ptr %s, align 4
  %5 = load i32, ptr %m, align 4
  %6 = load i32, ptr %n.addr, align 4
  %mul1 = mul nsw i32 %5, %6
  %add2 = add nsw i32 %4, %mul1
  %7 = load i32, ptr %i, align 4
  %add3 = add nsw i32 %add2, %7
  store i32 %add3, ptr %s, align 4
  %8 = load i32, ptr %i, align 4
  %add4 = add nsw i32 %8, 1
  store i32 %add4, ptr %i, align 4
  br label %while.cond, !llvm.loop !5

while.end:                                        ; preds = %while.cond
  %9 = load i32, ptr %s, align 4
  store i32 %9, ptr @total, align 4
  %10 = load i32, ptr %s, align 4
  %call = call i32 @scale(i32 noundef %10) #2
  %11 = load i32, ptr %n.addr, align 4
  %add5 = add nsw i32 %call, %11
  ret i32 %add5
}

declare i32 @scale(i32 noundef) #1

attributes #0 = { noinline nounwind optnone "frame-pointer"="all" "min-legal-vector-width"="0" "no-builtins" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="x86-64" "target-features"="+cmov,+cx8,+fxsr,+mmx,+sse,+sse2,+x87" "tune-cpu"="generic" }
attributes #1 = { "frame-pointer"="all" "no-builtins" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="x86-64" "target-features"="+cmov,+cx8,+fxsr,+mmx,+sse,+sse2,+x87" "tune-cpu"="generic" }
attributes #2 = { nobuiltin "no-builtins" }

!llvm.module.flags = !{!0, !1, !2, !3}
!llvm.ident = !{!4}

!0 = !{i32 1, !"wchar_size", i32 4}
!1 = !{i32 8, !"PIC Level", i32 2}
!2 = !{i32 7, !"PIE Level", i32 2}
!3 = !{i32 7, !"frame-pointer", i32 2}
!4 = !{!"Apple clang version 21.0.0 (clang-2100.4.1.1)"}
!5 = distinct !{!5, !6}
!6 = !{!"llvm.loop.mustprogress"}
